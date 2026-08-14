/**
 * OpenAI-compatible Chat Completions, called directly from the browser.
 *
 * The endpoint is configurable rather than fixed, which is what lets this talk
 * to Ollama, LM Studio, OpenRouter, Azure, or a self-hosted gateway as well as
 * OpenAI itself. Pointing it at a local model means a meeting never leaves the
 * machine at all — not the audio, and not the transcript.
 *
 * Local endpoints normally have no authentication, so the key is optional and
 * the Authorization header is omitted entirely when there is none. Sending
 * `Bearer undefined` makes some servers reject an otherwise fine request.
 *
 * No token limit is sent deliberately: OpenAI renamed `max_tokens` to
 * `max_completion_tokens` on newer models, and sending the wrong one is a hard
 * 400. Omitting both lets every model apply its own default and keeps this file
 * working across model generations and across third-party servers.
 */

import {
  FOLLOWUP_PROMPT,
  SUMMARY_SCHEMA,
  buildSystemPrompt,
  buildUserMessage,
  normalizeSummary,
} from './prompt.js';
import { partialSummary } from './partial-json.js';
import { estimateTokens, postWithRetry, readSSE } from './http.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

function headers(apiKey) {
  const out = { 'content-type': 'application/json' };
  if (apiKey) out.authorization = `Bearer ${apiKey}`;
  return out;
}

const endpoint = (baseUrl) => `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}/chat/completions`;

export async function summarizeWithOpenAI({
  apiKey,
  model,
  baseUrl,
  transcript,
  title,
  style,
  customPrompt,
  onDelta,
  onRetry,
}) {
  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt({ style, customPrompt }) },
      { role: 'user', content: buildUserMessage({ title, transcript }) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'meeting_summary', strict: true, schema: SUMMARY_SCHEMA },
    },
    stream: Boolean(onDelta),
  };

  const response = await postWithRetry(
    endpoint(baseUrl),
    { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) },
    { onRetry }
  ).catch((err) => {
    throw new Error(`Could not reach ${hostOf(baseUrl)}: ${err?.message || err}`);
  });

  if (!response.ok) throw new Error(await describeHttpError(response, baseUrl));

  const { text, finishReason, refusal } = onDelta
    ? await consumeStream(response, onDelta)
    : await consumeJson(response);

  assertUsable(finishReason, refusal);
  if (!text) throw new Error(`${hostOf(baseUrl)} returned an empty response.`);

  try {
    return normalizeSummary(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(
        `${hostOf(baseUrl)} returned a summary that was not valid JSON. ` +
          'Smaller local models sometimes ignore the response schema — try a larger one.'
      );
    }
    throw err;
  }
}

export async function askOpenAI({
  apiKey,
  model,
  baseUrl,
  transcript,
  title,
  history,
  question,
  onDelta,
  onRetry,
}) {
  const messages = [
    { role: 'system', content: FOLLOWUP_PROMPT },
    { role: 'user', content: buildUserMessage({ title, transcript }) },
    { role: 'assistant', content: 'Understood. Ask me about this meeting.' },
    ...(history || []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];

  const response = await postWithRetry(
    endpoint(baseUrl),
    {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ model, messages, stream: Boolean(onDelta) }),
    },
    { onRetry }
  ).catch((err) => {
    throw new Error(`Could not reach ${hostOf(baseUrl)}: ${err?.message || err}`);
  });

  if (!response.ok) throw new Error(await describeHttpError(response, baseUrl));

  const { text, finishReason, refusal } = onDelta
    ? await consumeStream(response, onDelta, { plainText: true })
    : await consumeJson(response);

  assertUsable(finishReason, refusal);
  return text || '(no answer)';
}

/**
 * No free token-counting endpoint exists across OpenAI-compatible servers, so
 * this is an estimate and the UI labels it as one.
 */
export function countTokensOpenAI({ transcript, title }) {
  return estimateTokens(buildUserMessage({ title, transcript }));
}

// ------------------------------------------------------------------ reading

async function consumeJson(response) {
  const body = await response.json();
  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content || '',
    finishReason: choice?.finish_reason,
    refusal: choice?.message?.refusal,
  };
}

async function consumeStream(response, onDelta, { plainText = false } = {}) {
  let text = '';
  let finishReason = null;
  let refusal = null;

  await readSSE(response, (event) => {
    const choice = event.choices?.[0];
    if (!choice) return;
    if (choice.delta?.refusal) refusal = (refusal || '') + choice.delta.refusal;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const piece = choice.delta?.content;
    if (!piece) return;
    text += piece;
    onDelta(plainText ? text : partialSummary(text));
  });

  return { text, finishReason, refusal };
}

function assertUsable(finishReason, refusal) {
  if (refusal) throw new Error(`The model declined to answer: ${refusal}`);
  if (finishReason === 'length') {
    throw new Error(
      'The response was cut off before it finished. This transcript may be unusually long — ' +
        'try a shorter meeting, or a model with a larger context window.'
    );
  }
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl || DEFAULT_BASE).host;
  } catch {
    return 'the API';
  }
}

async function describeHttpError(response, baseUrl) {
  const host = hostOf(baseUrl);
  let detail = '';
  try {
    detail = (await response.json())?.error?.message || '';
  } catch {
    /* non-JSON error body */
  }

  switch (response.status) {
    case 401:
      return `${host} rejected your API key (401). Check the key in Settings. ${detail}`.trim();
    case 403:
      return `Your key lacks permission for this request (403). ${detail}`.trim();
    case 404:
      return (
        `Not found (404) at ${host}. Check the model name and base URL in Settings — ` +
        `your account or server may not have that model. ${detail}`
      ).trim();
    case 400:
      return (
        `${host} rejected the request (400). ${detail} ` +
        'Some servers do not support structured output; a different model may be needed.'
      ).trim();
    case 429:
      return `Still rate limited after retrying (429). ${detail}`.trim();
    default:
      if (response.status >= 500) {
        return `${host} had a server error (${response.status}) that persisted through retries. ${detail}`.trim();
      }
      return `${host} API error ${response.status}. ${detail}`.trim();
  }
}
