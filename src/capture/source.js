/**
 * TranscriptSource — the seam between audio capture and text.
 *
 * Everything downstream (storage, summarization, UI) consumes only the events
 * below, so swapping the engine means adding one file here and changing which
 * constructor offscreen.js calls. That matters because Chrome's on-device
 * recognizer is not available on every machine; if it proves too patchy, a
 * local Whisper source can be dropped in without touching anything else.
 *
 * A source is constructed with:
 *   {
 *     track:    MediaStreamTrack   audio to recognize
 *     speaker:  string             label attached to every line ('You' | 'Others')
 *     language: string             BCP-47 tag, e.g. 'en-US'
 *     onLine:   ({ speaker, text, interim, t }) => void
 *     onError:  ({ fatal, code, message }) => void
 *   }
 *
 * and must implement `start()` and `stop()`.
 *
 * Contract notes:
 *  - `onLine` fires with `interim: true` for in-flight text and `interim: false`
 *    once a phrase is final. Only final lines are persisted.
 *  - `onError` with `fatal: true` means the source has given up and stopped;
 *    anything else is transient and the source keeps trying on its own.
 */

export class TranscriptSource {
  constructor({ track, speaker, language, onLine, onError }) {
    this.track = track;
    this.speaker = speaker;
    this.language = language;
    this.onLine = onLine || (() => {});
    this.onError = onError || (() => {});
    this.active = false;
  }

  async start() {
    throw new Error('not implemented');
  }

  stop() {
    throw new Error('not implemented');
  }
}
