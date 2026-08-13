/**
 * TranscriptSource backed by Chrome's built-in on-device speech recognition.
 *
 * Two properties make this the right engine for a free, private tool:
 *  - `processLocally = true` keeps audio on the machine — nothing is uploaded.
 *  - `start(audioTrack)` accepts a MediaStreamTrack, so tab audio captured with
 *    chrome.tabCapture can be recognized directly. Without that overload this
 *    whole approach would be limited to the microphone and could never hear
 *    remote participants.
 *
 * Both of those need Chrome 139+, which is why the manifest sets
 * `minimum_chrome_version`. On an older build the `audioTrack` argument is
 * silently ignored and the recognizer falls back to the microphone — which
 * would not error, it would just label every remote speaker as the local user.
 * Failing to install is far better than transcribing the wrong audio.
 *
 * The awkward part of the Web Speech API is that a recognizer is not a
 * long-lived stream. It stops itself on silence, on transient errors, and on
 * internal timeouts. Left alone it dies quietly a few minutes into a meeting
 * and the transcript simply stops. `#scheduleRestart` is what keeps it alive.
 */

import { TranscriptSource } from './source.js';

const SpeechRecognitionCtor =
  globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;

/** Errors that mean "stop trying" rather than "try again". */
const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);

const RESTART_BASE_MS = 250;
const RESTART_MAX_MS = 5000;

export function isSupported() {
  return Boolean(SpeechRecognitionCtor);
}

/**
 * Check whether on-device recognition can actually run for `language`, and
 * install the language pack if Chrome offers to.
 *
 * Returns `{ ok, status, message }`. Callers surface `message` directly — a
 * user whose machine can't do this needs to be told, not left staring at an
 * empty transcript that looks like it might still be warming up.
 */
export async function ensureOnDeviceReady(language) {
  if (!SpeechRecognitionCtor) {
    return {
      ok: false,
      status: 'unsupported',
      message:
        'This version of Chrome has no Web Speech API. Update Chrome to version 139 or later.',
    };
  }

  // available()/install() are newer than the base API. If they are missing we
  // cannot verify on-device support up front, so let the attempt proceed and
  // let a real error surface instead of blocking on a check that can't run.
  if (typeof SpeechRecognitionCtor.available !== 'function') {
    return { ok: true, status: 'unknown', message: '' };
  }

  const opts = { langs: [language], processLocally: true };
  let status;
  try {
    status = await SpeechRecognitionCtor.available(opts);
  } catch {
    return { ok: true, status: 'unknown', message: '' };
  }

  if (status === 'available') return { ok: true, status, message: '' };

  if (status === 'downloadable' || status === 'downloading') {
    try {
      const installed = await SpeechRecognitionCtor.install(opts);
      if (installed) return { ok: true, status: 'available', message: '' };
    } catch {
      /* fall through to the failure message below */
    }
    return {
      ok: false,
      status,
      message:
        `Chrome needs to download the on-device speech pack for ${language}. ` +
        'Open chrome://settings/languages, add the language, enable its speech ' +
        'recognition download, then try again.',
    };
  }

  return {
    ok: false,
    status: 'unavailable',
    message:
      `On-device speech recognition is unavailable for ${language} on this machine. ` +
      'This is a known gap on some platforms (notably macOS). Try another language ' +
      'in Settings, or check chrome://settings/languages for an installable speech pack.',
  };
}

export class ChromeSpeechSource extends TranscriptSource {
  #recognition = null;
  #restartTimer = null;
  #restartDelay = RESTART_BASE_MS;
  #stopping = false;
  #startedAt = 0;

  async start() {
    if (!SpeechRecognitionCtor) throw new Error('Web Speech API unavailable');
    if (this.track.readyState !== 'live') {
      throw new Error(`audio track for "${this.speaker}" is not live`);
    }
    this.active = true;
    this.#stopping = false;
    this.#startedAt = Date.now();
    this.#spinUp();
  }

  stop() {
    this.active = false;
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    if (this.#recognition) {
      // abort() discards pending audio; stop() would try to finalize against a
      // track we are about to tear down.
      try {
        this.#recognition.abort();
      } catch {
        /* already dead */
      }
      this.#recognition = null;
    }
  }

  #spinUp() {
    if (!this.active) return;

    // A track that has ended (tab closed, mic unplugged) can never recover, and
    // start() would throw InvalidStateError on every retry.
    if (this.track.readyState !== 'live') {
      this.active = false;
      this.onError({
        fatal: true,
        code: 'track-ended',
        message: `Audio for "${this.speaker}" stopped. The tab may have been closed.`,
      });
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = this.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // Requested, not merely preferred: audio must not leave the machine.
    recognition.processLocally = true;

    recognition.onresult = (event) => {
      // A successful result proves the pipeline is healthy, so forget any
      // backoff accumulated by earlier failures.
      this.#restartDelay = RESTART_BASE_MS;

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;
        this.onLine({
          speaker: this.speaker,
          text,
          interim: !result.isFinal,
          t: Date.now() - this.#startedAt,
        });
      }
    };

    recognition.onerror = (event) => {
      const code = event.error;

      // Routine: the recognizer heard nothing, or we aborted it ourselves.
      if (code === 'no-speech' || code === 'aborted') return;

      if (FATAL_ERRORS.has(code)) {
        this.active = false;
        this.onError({ fatal: true, code, message: describeError(code, this.speaker) });
        return;
      }

      this.onError({ fatal: false, code, message: describeError(code, this.speaker) });
    };

    recognition.onend = () => {
      if (this.#stopping || !this.active) return;
      this.#scheduleRestart();
    };

    this.#recognition = recognition;

    try {
      recognition.start(this.track);
    } catch (err) {
      // Most commonly InvalidStateError from a start() racing the previous
      // instance's teardown — worth retrying rather than failing the meeting.
      this.onError({ fatal: false, code: 'start-failed', message: String(err?.message || err) });
      this.#scheduleRestart();
    }
  }

  #scheduleRestart() {
    if (!this.active || this.#restartTimer) return;
    const delay = this.#restartDelay;
    this.#restartDelay = Math.min(this.#restartDelay * 2, RESTART_MAX_MS);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#spinUp();
    }, delay);
  }
}

function describeError(code, speaker) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return `Chrome blocked speech recognition for "${speaker}". Check the extension's microphone permission.`;
    case 'language-not-supported':
      return `The selected language is not supported for on-device recognition.`;
    case 'network':
      return `Speech recognition tried to reach the network and failed. Recognition should be on-device; check chrome://settings/languages for the speech pack.`;
    case 'audio-capture':
      return `Lost the audio device for "${speaker}".`;
    default:
      return `Speech recognition error (${code}) on "${speaker}". Retrying.`;
  }
}
