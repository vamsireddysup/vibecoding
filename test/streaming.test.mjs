/**
 * Streaming, retry, configurable endpoints, and cost estimation.
 *
 * These are the paths a user hits when something is slow, rate limited, or
 * pointed at a local model — exactly the cases that are awkward to reproduce by
 * hand, which is why they are pinned here.
 */

import { check, installChromeStorageMock, rejects, section, sseResponse } from './harness.mjs';

const SUMMARY = {
  tldr: 'Shipped it.',
  keyPoints: ['a'],
  decisions: [],
  actionItems: [{ task: 'deploy', owner: null, due: null }],
};

export default async function run() {
  installChromeStorageMock(); // config.js reads settings at call time
  const { summarizeWithAnthropic } = await import('../src/providers/anthropic.js');
  const { summarizeWithOpenAI } = await import('../src/providers/openai.js');
  const { estimateCost, formatEstimate } = await import('../src/providers/provider.js');
  const { postWithRetry, estimateTokens } = await import('../src/providers/http.js');
  const { activeCredentials, isLocalEndpoint } = await import('../src/config.js');

  section('streaming assembles a summary');
  const json = JSON.stringify(SUMMARY);
  const pieces = [json.slice(0, 20), json.slice(20, 45), json.slice(45)];
  globalThis.fetch = async () =>
    sseResponse([
      ...pieces.map((text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);

  const deltas = [];
  const streamed = await summarizeWithAnthropic({
    apiKey: 'k',
    model: 'claude-opus-5',
    transcript: 't',
    onDelta: (partial) => deltas.push(partial),
  });
  check('final result matches the non-streamed shape', streamed.tldr === 'Shipped it.');
  check('reports progress while streaming', deltas.length === pieces.length);
  check(
    'progress is partial, not raw JSON fragments',
    deltas.every((d) => typeof d.tldr === 'string' && Array.isArray(d.keyPoints))
  );
  check('the last progress update matches the final value', deltas.at(-1).tldr === 'Shipped it.');

  section('streaming surfaces a refusal');
  globalThis.fetch = async () =>
    sseResponse([{ type: 'message_delta', delta: { stop_reason: 'refusal' } }]);
  check(
    'a refusal mid-stream still throws',
    /declined/i.test(
      await rejects(
        summarizeWithAnthropic({ apiKey: 'k', model: 'm', transcript: 't', onDelta: () => {} })
      )
    )
  );

  section('retry on rate limits');
  let calls = 0;
  const retries = [];
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '0' : null) },
        json: async () => ({ error: { message: 'slow down' } }),
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ done: true }) };
  };
  const recovered = await postWithRetry('https://example.test', { method: 'POST' }, {
    onRetry: (info) => retries.push(info),
  });
  check('retries a 429 and eventually succeeds', recovered.ok && calls === 3, `calls=${calls}`);
  check('reports each retry', retries.length === 2);
  check('honours retry-after', retries.every((r) => r.waitMs === 0));

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
  };
  await postWithRetry('https://example.test', { method: 'POST' }, { maxRetries: 3 });
  check('does not retry a 401, which would fail identically', calls === 1, `calls=${calls}`);

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      headers: { get: (h) => (h === 'retry-after' ? '0' : null) },
      json: async () => ({}),
    };
  };
  const exhausted = await postWithRetry('https://example.test', {}, { maxRetries: 2 });
  check('gives up rather than looping forever', calls === 3 && exhausted.status === 429);

  section('configurable endpoint');
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, headers: init.headers };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: json } }] }),
    };
  };

  await summarizeWithOpenAI({ apiKey: 'k', model: 'm', transcript: 't' });
  check('defaults to OpenAI', seen.url === 'https://api.openai.com/v1/chat/completions');

  await summarizeWithOpenAI({
    apiKey: '',
    model: 'llama3',
    baseUrl: 'http://localhost:11434/v1',
    transcript: 't',
  });
  check('uses a custom base URL', seen.url === 'http://localhost:11434/v1/chat/completions');
  check('omits Authorization when there is no key', !('authorization' in seen.headers));

  await summarizeWithOpenAI({
    apiKey: 'k',
    model: 'm',
    baseUrl: 'https://openrouter.ai/api/v1/',
    transcript: 't',
  });
  check('tolerates a trailing slash', seen.url === 'https://openrouter.ai/api/v1/chat/completions');

  section('keyless local endpoints');
  check('localhost is recognized as local', isLocalEndpoint('http://localhost:11434/v1'));
  check('127.0.0.1 is recognized as local', isLocalEndpoint('http://127.0.0.1:1234/v1'));
  check('a remote host is not', !isLocalEndpoint('https://api.openai.com/v1'));
  check(
    'a local endpoint allows an empty key',
    activeCredentials({
      provider: 'openai',
      openaiBaseUrl: 'http://localhost:11434/v1',
      openaiKey: '',
      openaiModel: 'llama3',
    }).allowKeyless === true
  );
  check(
    'a remote endpoint still requires one',
    activeCredentials({
      provider: 'openai',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiKey: '',
      openaiModel: 'gpt-5',
    }).allowKeyless === false
  );

  section('cost estimate');
  check('estimates tokens from length', estimateTokens('a'.repeat(360)) === 100);

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ input_tokens: 12000 }),
  });
  const exact = await estimateCost({
    provider: 'anthropic',
    apiKey: 'k',
    model: 'claude-opus-5',
    transcript: 'x',
  });
  check('uses the free token-count endpoint', exact.exact === true && exact.tokens === 12000);
  check('prices it', Math.abs(exact.cost - 0.06) < 0.0001, String(exact.cost));
  check('formats it readably', formatEstimate(exact) === '12.0K tokens · $0.06', formatEstimate(exact));

  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  const fallback = await estimateCost({
    provider: 'anthropic',
    apiKey: 'k',
    model: 'claude-opus-5',
    transcript: 'y'.repeat(3600),
  });
  check('falls back to an estimate rather than failing', fallback.exact === false && fallback.tokens > 0);
  check('marks an estimate as approximate', formatEstimate(fallback).startsWith('~'));

  const local = await estimateCost({
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    transcript: 'z'.repeat(360),
  });
  check('a local endpoint costs nothing', local.cost === 0);
  check('and says so', formatEstimate(local).endsWith('free'), formatEstimate(local));

  const unknown = await estimateCost({
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    transcript: 'z'.repeat(360),
  });
  check('an unpriced endpoint reports tokens without inventing a cost', unknown.cost === null);
}
