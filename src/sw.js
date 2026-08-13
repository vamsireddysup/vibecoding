/**
 * Service worker: lifecycle, offscreen management, persistence, LLM dispatch.
 *
 * MV3 service workers are killed after ~30s idle, so no recording state is kept
 * in module scope. "Are we recording?" is always answered from storage via
 * getActiveMeetingId(), which means a worker restart mid-meeting is invisible.
 */

import {
  appendLines,
  createMeeting,
  deleteMeeting,
  endMeeting,
  getActiveMeetingId,
  getMeeting,
  listMeetings,
  saveSummary,
  transcriptText,
} from './store.js';
import { activeCredentials, getSettings } from './config.js';
import { summarize } from './providers/provider.js';

const OFFSCREEN_URL = 'src/offscreen.html';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
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

  // Only record the meeting once capture is confirmed, so a failed start does
  // not leave an empty meeting in the user's history.
  const meeting = await createMeeting({ title: tab.title, url: tab.url });

  broadcast('STATE', { recording: true, meetingId: meeting.id, warnings: response.warnings || [] });
  return { meetingId: meeting.id, warnings: response.warnings || [] };
}

async function stopRecording() {
  const meetingId = await getActiveMeetingId();
  await chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' })
    .catch(() => {});
  await closeOffscreen();
  const record = meetingId ? await endMeeting(meetingId) : null;
  broadcast('STATE', { recording: false, meetingId: null });
  return { meetingId, lineCount: record?.lines?.length || 0 };
}

// ------------------------------------------------------------ summarization

async function summarizeMeeting(meetingId) {
  const record = await getMeeting(meetingId);
  if (!record) throw new Error('Meeting not found.');
  if (!record.lines.length) throw new Error('This meeting has no transcript to summarize.');

  const settings = await getSettings();
  const creds = activeCredentials(settings);
  if (!creds.apiKey) {
    throw new Error(
      `No ${creds.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key set. ` +
        'Add one in Settings.'
    );
  }

  const summary = await summarize({
    ...creds,
    transcript: transcriptText(record),
    title: record.title,
  });

  await saveSummary(meetingId, summary, { provider: creds.provider, model: creds.model });
  return summary;
}

// ------------------------------------------------------------- message hub

const handlers = {
  START: () => startRecording(),
  STOP: () => stopRecording(),
  SUMMARIZE: ({ meetingId }) => summarizeMeeting(meetingId),
  LIST_MEETINGS: () => listMeetings(),
  GET_MEETING: ({ meetingId }) => getMeeting(meetingId),
  DELETE_MEETING: ({ meetingId }) => deleteMeeting(meetingId),
  GET_STATE: async () => {
    const meetingId = await getActiveMeetingId();
    return { recording: Boolean(meetingId), meetingId };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Messages from the offscreen document are notifications, not requests.
  if (message?.target === 'sw') {
    handleCaptureEvent(message);
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
  if (message.type === 'TRANSCRIPT_LINE') {
    const { line } = message;
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
