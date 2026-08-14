/**
 * Anthropic Messages API, called directly from the browser.
 *
 * Browser-side calls are rejected by CORS unless the request carries
 * `anthropic-dangerous-direct-browser-access: true`. Anthropic added that header
 * specifically for bring-your-own-key clients like this one — the "dangerous"
 * name warns against shipping *your* key in a page, which is not what happens
 * here: the key is the user's own and never leaves their browser profile.
 *
 * The transcript block carries `cache_control`, which is what makes follow-up
 * questions affordable. Caching is a prefix match, so ordering is load-bearing:
 * system prompt, then transcript (cached), then the varying question. Putting
 * the question before the transcript would mean nothing ever cached.
 */

import {
  FOLLOWUP_PROMPT,
  SUMMARY_SCHEMA,
  buildSystemPrompt,
  buildUserMessage,
  normalizeSummary,
} from './prompt.js';
import { partialSummary } from './partial-json.js';
import { postWithRetry, readSSE } from './http.js';

const BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

// Generous because on Claude Opus 5 thinking is on by default and max_tokens
// caps thinking *plus* the visible answer. A tight cap truncates the JSON.
const MAX_TOKENS = 16000;

function headers(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/** Transcript as its own cached block, so later calls re-read it cheaply. */
function cachedTranscriptBlock({ title, transcript }) {
  return {
    type: 'text',
    text: buildUserMessage({ title, transcript }),
    cache_control: { type: 'ephemeral' },
  };
}

export async function summarizeWithAnthropic({
  apiKey,
  model,
  transcript,
  title,
  style,
  customPrompt,
  onDelta,
  onRetry,
}) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt({ style, customPrompt }),
    messages: [{ role: 'user', content: [cachedTranscriptBlock({ title, transcript })] }],
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: SUMMARY_SCHEMA },
    },
    stream: Boolean(onDelta),
  };

  const response = await postWithRetry(
    `${BASE}/messages`,
    { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) },
    { onRetry }
  ).catch((err) => {
    throw new Error(`Could not reach the Anthropic API: ${err?.message || err}`);
  });

  if (!response.ok) throw new Error(await describeHttpError(response));

  const { text, stopReason, stopDetails } = onDelta
    ? await consumeStream(response, onDelta)
    : await consumeJson(response);

  assertUsable(stopReason, stopDetails);
  if (!text) throw new Error('Claude returned an empty response.');

  try {
    return normalizeSummary(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('Claude returned a summary that was not valid JSON.');
    }
    throw err;
  }
}

export async function askAnthropic({
  apiKey,
  model,
  transcript,
  title,
  history,
  question,
  onDelta,
  onRetry,
}) {
  // Transcript first and cached; conversation and question after it, so the
  // cached prefix stays byte-identical across questions.
  const messages = [
    { role: 'user', content: [cachedTranscriptBlock({ title, transcript })] },
    { role: 'assistant', content: 'Understood. Ask me about this meeting.' },
    ...(history || []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];

  const response = await postWithRetry(
    `${BASE}/messages`,
    {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        system: FOLLOWUP_PROMPT,
        messages,
        stream: Boolean(onDelta),
      }),
    },
    { onRetry }
  ).catch((err) => {
    throw new Error(`Could not reach the Anthropic API: ${err?.message || err}`);
  });

  if (!response.ok) throw new Error(await describeHttpError(response));

  const { text, stopReason, stopDetails } = onDelta
    ? await consumeStream(response, onDelta, { plainText: true })
    : await consumeJson(response);

  assertUsable(stopReason, stopDetails);
  return text || '(no answer)';
}

/** Free token count, so the cost estimate is real rather than guessed. */
export async function countTokensAnthropic({ apiKey, model, transcript, title }) {
  const response = await fetch(`${BASE}/messages/count_tokens`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      model,
      system: buildSystemPrompt({}),
      messages: [{ role: 'user', content: buildUserMessage({ title, transcript }) }],
    }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  return typeof body.input_tokens === 'number' ? body.input_tokens : null;
}

// ------------------------------------------------------------------ reading

async function consumeJson(response) {
  const body = await response.json();
  const text = (body.content || []).find((block) => block.type === 'text')?.text || '';
  return { text, stopReason: body.stop_reason, stopDetails: body.stop_details };
}

/**
 * Accumulate a streamed response, reporting progress as it arrives.
 *
 * For summaries the deltas are JSON, so the caller is handed the parts that are
 * already complete rather than raw fragments. For follow-up answers the deltas
 * are prose and pass through directly.
 */
async function consumeStream(response, onDelta, { plainText = false } = {}) {
  let text = '';
  let stopReason = null;
  let stopDetails = null;

  await readSSE(response, (event) => {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      text += event.delta.text;
      onDelta(plainText ? text : partialSummary(text));
      return;
    }
    if (event.type === 'message_delta') {
      stopReason = event.delta?.stop_reason ?? stopReason;
      stopDetails = event.delta?.stop_details ?? stopDetails;
    }
  });

  return { text, stopReason, stopDetails };
}

/**
 * Claude Opus 5 can decline a request outright; that arrives as a successful
 * HTTP 200 with empty content, so stop_reason must be checked before the body
 * is read as an answer.
 */
function assertUsable(stopReason, stopDetails) {
  if (stopReason === 'refusal') {
    throw new Error(
      'Claude declined to process this transcript' +
        (stopDetails?.explanation ? `: ${stopDetails.explanation}` : '.')
    );
  }
  if (stopReason === 'max_tokens') {
    throw new Error(
      'The response was cut off before it finished. This transcript may be unusually long — ' +
        'try a shorter meeting, or a model with a larger context window.'
    );
  }
}

async function describeHttpError(response) {
  let detail = '';
  try {
    detail = (await response.json())?.error?.message || '';
  } catch {
    /* non-JSON error body */
  }

  switch (response.status) {
    case 401:
      return `Anthropic rejected your API key (401). Check the key in Settings. ${detail}`.trim();
    case 403:
      return `Your Anthropic key lacks permission for this request (403). ${detail}`.trim();
    case 404:
      return `Model not found (404). Check the selected model in Settings. ${detail}`.trim();
    case 413:
      return `The transcript is too large for one request (413). ${detail}`.trim();
    case 429: {
      const retry = response.headers.get('retry-after');
      return (
        `Still rate limited by Anthropic after retrying (429).` +
        `${retry ? ` Try again in ${retry}s.` : ''} ${detail}`
      ).trim();
    }
    default:
      if (response.status >= 500) {
        return `Anthropic had a server error (${response.status}) that persisted through retries. ${detail}`.trim();
      }
      return `Anthropic API error ${response.status}. ${detail}`.trim();
  }
}
