/**
 * Shared HTTP behaviour for both providers: retry on rate limits, and reading
 * Server-Sent Events.
 *
 * Retrying belongs here rather than in the UI because a 429 has exactly one
 * sensible response — wait the interval the server named, then try again. Making
 * the user read an error and click the button again is just a manual retry with
 * extra steps and a worse chance of picking the right delay.
 */

const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST with retry on 429 and 5xx.
 *
 * Only these are retried: a 400 or 401 will fail identically however many times
 * it is sent, so retrying one wastes the user's time and hides the real problem.
 */
export async function postWithRetry(url, init, { maxRetries = DEFAULT_MAX_RETRIES, onRetry } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      // Network-level failure. Worth one or two retries; a genuinely offline
      // machine will exhaust them quickly.
      lastError = err;
      if (attempt === maxRetries) throw err;
      const wait = backoff(attempt);
      onRetry?.({ attempt: attempt + 1, waitMs: wait, reason: 'network' });
      await sleep(wait);
      continue;
    }

    if (response.status !== 429 && response.status < 500) return response;
    if (attempt === maxRetries) return response;

    const wait = retryAfterMs(response) ?? backoff(attempt);
    onRetry?.({
      attempt: attempt + 1,
      waitMs: wait,
      reason: response.status === 429 ? 'rate-limit' : 'server-error',
    });
    await sleep(wait);
  }

  throw lastError || new Error('Request failed after retries.');
}

/** Honour the server's own retry interval when it gives one. */
function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const at = Date.parse(header); // the header may also be an HTTP date
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS);
  return null;
}

function backoff(attempt) {
  // Jittered so several tabs retrying at once do not synchronize.
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return base / 2 + Math.random() * (base / 2);
}

/**
 * Read an SSE body, invoking `onEvent(data)` for each `data:` payload.
 * Terminal `[DONE]` sentinels are swallowed rather than handed on.
 */
export async function readSSE(response, onEvent) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('This response cannot be streamed.');

  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; a partial trailing event stays in
    // the buffer until the rest of it arrives.
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          // A malformed event should not abort a stream that is otherwise fine.
        }
      }
    }
  }
}

/**
 * Rough token estimate for endpoints with no token-counting API.
 *
 * Deliberately conservative — English averages nearer 4 characters per token,
 * but transcripts carry names and technical terms that tokenize worse, and a
 * cost estimate that reads low is worse than one that reads slightly high.
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 3.6);
}
