/**
 * Offscreen capture host.
 *
 * Owns the audio graph and the recognizers. Runs in a hidden document because
 * the service worker has no DOM and cannot call getUserMedia or construct a
 * SpeechRecognition.
 *
 * Two streams are captured, and they are handled asymmetrically:
 *
 *   tab audio  — everyone else on the call. MUST be re-piped to the speakers
 *                (see startCapture) and is labelled "Others".
 *   microphone — the local user. Must NOT be re-piped, or they hear themselves
 *                echoed back. Labelled "You".
 *
 * Recognizing them separately is what gives the summary speaker attribution
 * without any diarization model.
 */

import { ChromeSpeechSource, ensureOnDeviceReady, isSupported } from './capture/chrome-speech.js';

const SPEAKER_TAB = 'Others';
const SPEAKER_MIC = 'You';

// Interim results fire several times a second. Final results are rare and
// always forwarded; interim ones are throttled so live display does not keep
// the service worker pinned awake for the whole meeting.
const INTERIM_THROTTLE_MS = 250;

let audioContext = null;
let tabStream = null;
let micStream = null;
let sources = [];
let lastInterimAt = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'START_CAPTURE') {
    startCapture(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep the message channel open for the async reply
  }

  if (message.type === 'STOP_CAPTURE') {
    stopCapture();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

function send(type, payload = {}) {
  // The service worker may be asleep and the panel may be closed; a rejected
  // send is expected, not an error worth surfacing.
  chrome.runtime.sendMessage({ target: 'sw', type, ...payload }).catch(() => {});
}

async function startCapture({ streamId, language, captureTab, captureMic }) {
  stopCapture();

  if (!isSupported()) {
    throw new Error('This version of Chrome has no Web Speech API. Update to Chrome 139 or later.');
  }

  const readiness = await ensureOnDeviceReady(language);
  if (!readiness.ok) throw new Error(readiness.message);

  const warnings = [];

  if (captureTab) {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
    });

    // chrome.tabCapture silently MUTES the captured tab. Without routing the
    // stream back to the speakers the user goes deaf for the whole meeting.
    // This is the single most important line in the file.
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(tabStream).connect(audioContext.destination);
  }

  if (captureMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Deliberately NOT connected to audioContext.destination — that would
      // echo the user's own voice back at them.
    } catch (err) {
      // Losing the mic costs speaker attribution but not the meeting. Carry on
      // with tab audio and tell the user what they lost.
      warnings.push(
        'Microphone unavailable, so your own speech will not be transcribed. ' +
          `Grant microphone access to the extension to fix this. (${err?.name || err})`
      );
      micStream = null;
    }
  }

  const tracks = [
    [tabStream, SPEAKER_TAB],
    [micStream, SPEAKER_MIC],
  ];

  for (const [stream, speaker] of tracks) {
    const track = stream?.getAudioTracks?.()[0];
    if (!track) continue;
    const source = new ChromeSpeechSource({
      track,
      speaker,
      language,
      onLine: handleLine,
      onError: (err) => handleSourceError(err, speaker),
    });
    await source.start();
    sources.push(source);
  }

  if (!sources.length) {
    stopCapture();
    throw new Error('No audio source could be captured. Check the tab and microphone permissions.');
  }

  return { warnings, speakers: sources.map((s) => s.speaker) };
}

function handleLine(line) {
  if (line.interim) {
    const now = Date.now();
    if (now - lastInterimAt < INTERIM_THROTTLE_MS) return;
    lastInterimAt = now;
  }
  send('TRANSCRIPT_LINE', { line });
}

function handleSourceError(err, speaker) {
  send('CAPTURE_WARNING', { fatal: Boolean(err.fatal), code: err.code, message: err.message });

  // If every source has given up, the meeting is over whether the user knows
  // it or not — tell the service worker so it can stop cleanly.
  if (err.fatal && sources.every((s) => !s.active)) {
    send('CAPTURE_FAILED', { message: `Transcription stopped: ${err.message}` });
    stopCapture();
  }
}

function stopCapture() {
  for (const source of sources) {
    try {
      source.stop();
    } catch {
      /* already torn down */
    }
  }
  sources = [];

  for (const stream of [tabStream, micStream]) {
    stream?.getTracks?.().forEach((track) => track.stop());
  }
  tabStream = null;
  micStream = null;

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  lastInterimAt = 0;
}
