/**
 * Service worker: lifecycle, offscreen management, persistence, LLM dispatch.
 *
 * MV3 service workers are killed after ~30s idle, so no *durable* state lives in
 * module scope. "Are we recording?" is always answered from storage via
 * getActiveMeetingId(), so a worker restart mid-meeting is invisible.
 *
 * The one piece of module-scope state is the active-speaker ring buffer, which
 * is intentionally disposable: losing it after an idle restart costs speaker
 * attribution for a few lines, never a transcript.
 */

import {
  appendChat,
  appendLines,
  createMeeting,
  deleteMeeting,
  endMeeting,
  getActiveMeetingId,
  getLines,
  getMeeting,
  getMeetingWithLines,
  listMeetings,
  listSpeakers,
  saveSummary,
  setSpeakerAlias,
  transcriptText,
} from './store.js';
import { activeCredentials, getSettings } from './config.js';
import { askFollowUp, estimateCost, summarize } from './providers/provider.js';

const OFFSCREEN_URL = 'src/offscreen.html';

/** Tabs we recognize as meetings, for one-click record. */
const MEETING_PATTERNS = [
  { test: /^https:\/\/meet\.google\.com\/[a-z-]{10,}/i, platform: 'Google Meet' },
  { test: /^https:\/\/[\w.-]*zoom\.us\/(wc|j|s)\//i, platform: 'Zoom (web)' },
  { test: /^https:\/\/teams\.(microsoft|live)\.com\//i, platform: 'Microsoft Teams (web)' },
  { test: /^https:\/\/[\w.-]*whereby\.com\//i, platform: 'Whereby' },
  { test: /^https:\/\/app\.slack\.com\/huddle\//i, platform: 'Slack huddle' },
];

export function detectMeeting(url = '') {
  return MEETING_PATTERNS.find((p) => p.test.test(url))?.platform || null;
}

/**
 * `chrome.tabCapture` will not hand out a stream for a tab unless the extension
 * has been *invoked* on that tab — Chrome grants that on an action click, a
 * keyboard shortcut, or a context-menu use, and the grant then sticks to the
 * tab until it navigates.
 *
 * Pressing a button inside the side panel is NOT an invocation: the gesture
 * happens in the panel's own document, not in the page being captured. So the
 * action click is handled explicitly here, rather than delegated to
 * `setPanelBehavior({openPanelOnActionClick: true})` — that opens the panel
 * *instead of* firing this listener, leaving the extension never invoked and
 * every capture attempt failing with "Extension has not been invoked".
 *
 * The tab that was invoked is remembered so that Start captures *that* tab,
 * not whichever tab happens to be focused when the button is finally pressed.
 */
const INVOKED_KEY = 'invokedTab';

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id != null) {
    await chrome.storage.local.set({
      [INVOKED_KEY]: { tabId: tab.id, url: tab.url || '', title: tab.title || '', at: Date.now() },
    });
  }
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch {
    // Older builds, or a window that cannot host the panel.
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  broadcast('STATE_REFRESH');
});

// A keyboard shortcut is itself an invocation, so this path can capture the
// focused tab directly without the action click.
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  try {
    if (await getActiveMeetingId()) {
      await stopRecording();
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) {
      await chrome.storage.local.set({
        [INVOKED_KEY]: { tabId: tab.id, url: tab.url || '', title: tab.title || '', at: Date.now() },
      });
    }
    await startRecording();
  } catch (err) {
    broadcast('WARNING', { message: String(err?.message || err), fatal: true });
  }
});

/**
 * The tab the extension was invoked on, if it is still capturable.
 *
 * Navigation revokes the grant, so a tab that has since moved to a different
 * page is treated as not invoked — better to say so than to fail inside
 * getMediaStreamId with a message that blames the wrong thing.
 */
async function invokedTab() {
  const stored = (await chrome.storage.local.get(INVOKED_KEY))[INVOKED_KEY];
  if (!stored) return null;
  const tab = await chrome.tabs.get(stored.tabId).catch(() => null);
  if (!tab) return null;
  if (stored.url && tab.url && originOf(tab.url) !== originOf(stored.url)) return null;
  return tab;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const INVOKE_HINT =
  'Click the Meeting Notes icon in the toolbar while your meeting tab is open, then press ' +
  'Start. Chrome only lets an extension capture a tab it has been opened from, and a button ' +
  'inside this panel does not count.';

// ---------------------------------------------------------------- offscreen

async function hasOffscreen() {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification:
      'Capture meeting audio and run on-device speech recognition, which require a DOM.',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

/** Tell the panel something happened. Safe to call with no panel open. */
function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ target: 'panel', type, ...payload }).catch(() => {});
}

// ---------------------------------------------------- speaker attribution

/**
 * Recent active-speaker observations from the content script, newest last.
 * Bounded because a long meeting would otherwise grow it without limit.
 */
const speakerLog = [];
const SPEAKER_LOG_MAX = 400;
/** Names seen on the meeting page, offered as choices in the rename UI. */
let knownParticipants = [];
/** How far back a line may reach for an active speaker. */
const SPEAKER_MATCH_WINDOW_MS = 12000;

function noteActiveSpeaker(name, at) {
  if (!name) return;
  const last = speakerLog[speakerLog.length - 1];
  if (last && last.name === name) {
    last.until = at; // same person still talking — extend rather than append
    return;
  }
  speakerLog.push({ name, at, until: at });
  if (speakerLog.length > SPEAKER_LOG_MAX) speakerLog.shift();
}

/**
 * Attribute a tab-audio line to a named participant, when the content script
 * saw someone speaking around the time the phrase ended. Falls back to the
 * generic label rather than guessing.
 */
export function attributeSpeaker(line, log = speakerLog, now = Date.now()) {
  if (line.speaker !== 'Others') return line;
  const at = line.at || now;

  let best = null;
  for (const entry of log) {
    if (entry.at - 1500 > at) continue; // started after the phrase ended
    if (at - entry.until > SPEAKER_MATCH_WINDOW_MS) continue; // too stale
    best = entry;
  }
  return best ? { ...line, speaker: best.name } : line;
}

// ------------------------------------------------------------ start / stop

async function startRecording() {
  if (await getActiveMeetingId()) throw new Error('A recording is already in progress.');

  // Capture the tab the extension was opened from, not whichever tab happens to
  // be focused now — the user may well have clicked back to the meeting after
  // opening the panel, or away from it.
  const tab = await invokedTab();
  if (!tab?.id) throw new Error(INVOKE_HINT);
  if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
    throw new Error('Browser-internal pages cannot be captured. Open your meeting in a normal tab.');
  }

  // Must be obtained before the offscreen document asks for the stream.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    const detail = String(err?.message || err);
    // The invocation grant is gone — usually because the tab navigated after
    // the icon was clicked. Re-clicking the icon restores it.
    if (/invoked|activeTab/i.test(detail)) throw new Error(INVOKE_HINT);
    throw new Error(`Could not get audio access for that tab: ${detail}`);
  }

  const settings = await getSettings();
  await ensureOffscreen();

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    language: settings.language,
    captureTab: settings.captureTab,
    captureMic: settings.captureMic,
  });

  if (!response?.ok) {
    await closeOffscreen();
    throw new Error(response?.error || 'Capture failed to start.');
  }

  speakerLog.length = 0;

  // Only record the meeting once capture is confirmed, so a failed start does
  // not leave an empty meeting in the user's history.
  const meeting = await createMeeting({ title: tab.title, url: tab.url });

  broadcast('STATE', { recording: true, meetingId: meeting.id, warnings: response.warnings || [] });
  return { meetingId: meeting.id, warnings: response.warnings || [] };
}

async function stopRecording() {
  const meetingId = await getActiveMeetingId();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' }).catch(() => {});
  await closeOffscreen();
  const record = meetingId ? await endMeeting(meetingId) : null;
  speakerLog.length = 0;
  broadcast('STATE', { recording: false, meetingId: null });
  return { meetingId, lineCount: record?.lineCount || 0 };
}

// ------------------------------------------------------------ model calls

async function credentialsOrThrow() {
  const settings = await getSettings();
  const creds = activeCredentials(settings);
  // A custom endpoint (Ollama, LM Studio) legitimately has no key.
  if (!creds.apiKey && !creds.allowKeyless) {
    throw new Error(
      `No ${creds.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key set. Add one in Settings.`
    );
  }
  return { settings, creds };
}

async function summarizeMeeting(meetingId) {
  const record = await getMeeting(meetingId);
  if (!record) throw new Error('Meeting not found.');
  const lines = await getLines(meetingId);
  if (!lines.length) throw new Error('This meeting has no transcript to summarize.');

  const { settings, creds } = await credentialsOrThrow();

  const summary = await summarize({
    ...creds,
    transcript: transcriptText(lines),
    title: record.title,
    style: settings.summaryStyle,
    customPrompt: settings.customPrompt,
    onDelta: (text) => broadcast('SUMMARY_DELTA', { meetingId, text }),
  });

  await saveSummary(meetingId, summary, { provider: creds.provider, model: creds.model });
  broadcast('SUMMARY_DONE', { meetingId });
  return summary;
}

async function askAboutMeeting(meetingId, question) {
  const record = await getMeeting(meetingId);
  if (!record) throw new Error('Meeting not found.');
  const lines = await getLines(meetingId);
  if (!lines.length) throw new Error('This meeting has no transcript to ask about.');

  const { creds } = await credentialsOrThrow();

  const answer = await askFollowUp({
    ...creds,
    transcript: transcriptText(lines),
    title: record.title,
    history: record.chat || [],
    question,
    onDelta: (text) => broadcast('ANSWER_DELTA', { meetingId, text }),
  });

  const chat = await appendChat(meetingId, [
    { role: 'user', content: question, at: Date.now() },
    { role: 'assistant', content: answer, at: Date.now() },
  ]);
  return { answer, chat };
}

async function estimateForMeeting(meetingId) {
  const lines = await getLines(meetingId);
  const { creds } = await credentialsOrThrow().catch(() => ({ creds: null }));
  if (!creds) return null;
  return estimateCost({ ...creds, transcript: transcriptText(lines) });
}

// ------------------------------------------------------------- message hub

const handlers = {
  START: () => startRecording(),
  STOP: () => stopRecording(),
  SUMMARIZE: ({ meetingId }) => summarizeMeeting(meetingId),
  ASK: ({ meetingId, question }) => askAboutMeeting(meetingId, question),
  ESTIMATE: ({ meetingId }) => estimateForMeeting(meetingId),
  LIST_MEETINGS: () => listMeetings(),
  GET_MEETING: ({ meetingId }) => getMeetingWithLines(meetingId),
  DELETE_MEETING: ({ meetingId }) => deleteMeeting(meetingId),
  LIST_SPEAKERS: async ({ meetingId }) => ({
    speakers: await listSpeakers(meetingId),
    // Real names from the call, so renaming is a pick rather than a typing test.
    suggestions: knownParticipants,
  }),
  RENAME_SPEAKER: ({ meetingId, from, to }) => setSpeakerAlias(meetingId, from, to),
  GET_STATE: async () => {
    const meetingId = await getActiveMeetingId();
    // Report the tab we can actually capture, so the panel never invites a
    // click that is guaranteed to fail.
    const tab = await invokedTab();
    return {
      recording: Boolean(meetingId),
      meetingId,
      canRecord: Boolean(tab?.id),
      detectedMeeting: detectMeeting(tab?.url || ''),
      tabTitle: tab?.title || '',
      invokeHint: INVOKE_HINT,
    };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Notifications from the offscreen document and content scripts.
  if (message?.target === 'sw') {
    handleCaptureEvent(message, sender);
    return false;
  }

  if (message?.target !== 'panel-request') return false;

  const handler = handlers[message.type];
  if (!handler) return false;

  Promise.resolve(handler(message))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});

async function handleCaptureEvent(message) {
  if (message.type === 'ACTIVE_SPEAKER') {
    noteActiveSpeaker(message.name, message.at || Date.now());
    return;
  }

  if (message.type === 'PARTICIPANTS') {
    knownParticipants = message.names || [];
    return;
  }

  if (message.type === 'TRANSCRIPT_LINE') {
    const line = attributeSpeaker(message.line);
    // Interim lines are display-only; persisting them would mean a storage
    // write several times a second.
    if (!line.interim) {
      const meetingId = await getActiveMeetingId();
      if (meetingId) await appendLines(meetingId, [line]);
    }
    broadcast('LINE', { line });
    return;
  }

  if (message.type === 'CAPTURE_WARNING') {
    broadcast('WARNING', { message: message.message, fatal: message.fatal });
    return;
  }

  if (message.type === 'CAPTURE_FAILED') {
    broadcast('WARNING', { message: message.message, fatal: true });
    await stopRecording();
  }
}
