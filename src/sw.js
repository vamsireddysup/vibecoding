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

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Start/stop without opening the panel at all.
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  try {
    if (await getActiveMeetingId()) await stopRecording();
    else await startRecording();
  } catch (err) {
    broadcast('WARNING', { message: String(err?.message || err), fatal: true });
  }
});

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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab to record.');
  if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
    throw new Error('Browser-internal pages cannot be captured. Switch to your meeting tab.');
  }

  // Must be obtained before the offscreen document asks for the stream.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    throw new Error(
      `Could not get audio access for this tab (${err?.message || err}). ` +
        'Click the extension icon on the meeting tab, then press Start again.'
    );
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return {
      recording: Boolean(meetingId),
      meetingId,
      detectedMeeting: detectMeeting(tab?.url || ''),
      tabTitle: tab?.title || '',
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
