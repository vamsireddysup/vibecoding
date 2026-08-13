/**
 * On-device recognition: availability gating and the restart loop.
 *
 * The restart loop is the least obvious and most important behaviour in the
 * extension. Chrome's SpeechRecognition stops itself on silence and on
 * transient errors; without the loop, transcription dies quietly partway
 * through a meeting and the user only finds out afterwards.
 */

import { check, installSpeechRecognitionMock, liveTrack, section, sleep } from './harness.mjs';

export default async function run() {
  const mock = installSpeechRecognitionMock();
  const { ChromeSpeechSource, ensureOnDeviceReady } = await import('../src/capture/chrome-speech.js');

  section('availability gating');
  mock.setAvailability('available');
  check('reports ready when available', (await ensureOnDeviceReady('en-US')).ok);

  mock.setAvailability('unavailable');
  const unavailable = await ensureOnDeviceReady('en-US');
  check('reports not ready when unavailable', !unavailable.ok);
  check(
    'gives the user somewhere to go',
    /macOS|chrome:\/\/settings/.test(unavailable.message),
    unavailable.message
  );

  mock.setAvailability('downloadable');
  check('installs a downloadable language pack', (await ensureOnDeviceReady('en-US')).ok);
  mock.setAvailability('available');

  section('recognition');
  const lines = [];
  const errors = [];
  const track = liveTrack();
  const source = new ChromeSpeechSource({
    track,
    speaker: 'Others',
    language: 'en-US',
    onLine: (l) => lines.push(l),
    onError: (e) => errors.push(e),
  });
  await source.start();

  check('recognizes the supplied track, not the default mic', mock.latest().track === track);
  check('requests on-device processing', mock.latest().processLocally === true);
  check('runs continuously', mock.latest().continuous === true);

  mock.latest().emit('hello there', false);
  check('marks interim results', lines[0].interim === true);
  mock.latest().emit('hello there world', true);
  check('marks final results', lines[1].interim === false);
  check('tags the speaker', lines[1].speaker === 'Others');
  check('timestamps the line', typeof lines[1].t === 'number');

  section('restart loop');
  let count = mock.instances.length;
  mock.latest().die();
  await sleep(400);
  check('restarts after the recognizer stops on silence', mock.instances.length === count + 1);
  check('the replacement is running', mock.latest().started === true);

  count = mock.instances.length;
  mock.latest().die('network');
  await sleep(700);
  check('restarts after a transient error', mock.instances.length === count + 1);
  check('surfaces transient errors as non-fatal', errors.some((e) => !e.fatal && e.code === 'network'));

  count = mock.instances.length;
  mock.latest().die('network');
  await sleep(60);
  check('backs off instead of hammering', mock.instances.length === count);
  await sleep(1600);
  check('restarts once the backoff elapses', mock.instances.length > count);

  section('giving up correctly');
  count = mock.instances.length;
  mock.latest().die('not-allowed');
  await sleep(500);
  check('does not restart after a permission error', mock.instances.length === count);
  check('flags the error as fatal', errors.some((e) => e.fatal && e.code === 'not-allowed'));
  check('marks itself inactive', source.active === false);

  const endedErrors = [];
  const closingTrack = liveTrack();
  const second = new ChromeSpeechSource({
    track: closingTrack,
    speaker: 'You',
    language: 'en-US',
    onLine: () => {},
    onError: (e) => endedErrors.push(e),
  });
  await second.start();
  count = mock.instances.length;
  closingTrack.readyState = 'ended'; // the meeting tab was closed
  mock.latest().die();
  await sleep(400);
  check('stops when the audio track ends', mock.instances.length === count);
  check('reports the ended track as fatal', endedErrors.some((e) => e.fatal && e.code === 'track-ended'));

  section('explicit stop');
  const third = new ChromeSpeechSource({
    track: liveTrack(),
    speaker: 'You',
    language: 'en-US',
    onLine: () => {},
    onError: () => {},
  });
  await third.start();
  count = mock.instances.length;
  third.stop();
  check('aborts the active recognizer', mock.instances[count - 1].aborted === true);
  await sleep(400);
  check('does not restart after an explicit stop', mock.instances.length === count);

  const rejected = await new ChromeSpeechSource({
    track: { kind: 'audio', readyState: 'ended' },
    speaker: 'X',
    language: 'en-US',
  })
    .start()
    .then(() => false, () => true);
  check('refuses to start on a dead track', rejected);
}
