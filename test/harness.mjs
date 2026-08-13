/**
 * A tiny assertion harness and the fakes the suites share.
 *
 * There is no test framework and no dependency on purpose: this repo has no
 * build step, and `node test/run.mjs` should work on a fresh clone.
 */

let pass = 0;
let fail = 0;
const failures = [];

export function section(name) {
  console.log(`\n${name}`);
}

export function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

export async function rejects(promise) {
  return promise.then(
    () => null,
    (err) => String(err?.message || err)
  );
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function report() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(`failing: ${failures.join(', ')}`);
  return fail === 0;
}

/** In-memory stand-in for chrome.storage.local. */
export function installChromeStorageMock() {
  const mem = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(k) {
          const keys = Array.isArray(k) ? k : [k];
          const out = {};
          for (const key of keys) if (key in mem) out[key] = structuredClone(mem[key]);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) mem[k] = structuredClone(v);
        },
        async remove(k) {
          (Array.isArray(k) ? k : [k]).forEach((key) => delete mem[key]);
        },
      },
    },
  };
  return mem;
}

/**
 * Swap in a fetch that returns a canned response and records the request, so a
 * suite can assert on headers and body without touching the network.
 */
export function installFetchMock() {
  const state = { last: null };
  state.reply = (status, body, headers = {}) => {
    globalThis.fetch = (url, init) => {
      state.last = { url, init, headers: init?.headers || {}, body: safeParse(init?.body) };
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        url,
        headers: { get: (h) => headers[h] ?? null },
        json: async () => body,
      });
    };
  };
  state.failWith = (message) => {
    globalThis.fetch = () => Promise.reject(new Error(message));
  };
  return state;
}

function safeParse(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Fake SpeechRecognition. Lets a suite drive results, errors, and the
 * stop-on-silence behaviour that the real API exhibits.
 */
export function installSpeechRecognitionMock() {
  const instances = [];

  class MockSpeechRecognition {
    static _availability = 'available';
    static available = async () => MockSpeechRecognition._availability;
    static install = async () => true;

    constructor() {
      this.started = false;
      this.aborted = false;
      instances.push(this);
    }

    start(track) {
      if (!track) throw new Error('no track supplied');
      this.started = true;
      this.track = track;
    }

    abort() {
      this.started = false;
      this.aborted = true;
    }

    stop() {
      this.started = false;
    }

    /** Emit one recognition result. */
    emit(text, isFinal) {
      const alternatives = [{ transcript: text }];
      alternatives.isFinal = isFinal;
      this.onresult({ resultIndex: 0, results: [alternatives] });
    }

    /** End the session, optionally reporting an error first. */
    die(code) {
      if (code) this.onerror({ error: code });
      this.started = false;
      this.onend();
    }
  }

  globalThis.SpeechRecognition = MockSpeechRecognition;
  globalThis.window = globalThis;

  return {
    instances,
    latest: () => instances[instances.length - 1],
    setAvailability: (v) => {
      MockSpeechRecognition._availability = v;
    },
  };
}

export const liveTrack = () => ({ kind: 'audio', readyState: 'live' });
