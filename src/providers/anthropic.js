/**
 * Anthropic Messages API, called directly from the browser.
 *
 * Browser-side calls are rejected by CORS unless the request carries
 * `anthropic-dangerous-direct-browser-access: true`. Anthropic added that header
 * specifically for bring-your-own-key clients like this one — the "dangerous"
 * name warns against shipping *your* key in a page, which is not what happens
 * here: the key is the user's own and never leaves their browser profile.
 */

import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, normalizeSummary } from './prompt.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Generous because on Claude Opus 5 thinking is on by default and max_tokens
// caps thinking *plus* the visible answer. A tight cap truncates the JSON.
const MAX_TOKENS = 16000;

export async function summarizeWithAnthropic({ apiKey, model, transcript, title }) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage({ title, transcript }) }],
        output_config: {
          effort: 'medium',
          format: { type: 'json_schema', schema: SUMMARY_SCHEMA },
        },
      }),
    });
  } catch (err) {
    throw new Error(`Could not reach the Anthropic API: ${err?.message || err}`);
  }

  if (!response.ok) throw new Error(await describeHttpError(response));

  const body = await response.json();

  // Claude Opus 5 can decline a request outright; this arrives as HTTP 200 with
  // an empty content array, so checking stop_reason must come before reading it.
  if (body.stop_reason === 'refusal') {
    throw new Error(
      'Claude declined to summarize this transcript' +
        (body.stop_details?.explanation ? `: ${body.stop_details.explanation}` : '.')
    );
  }

  if (body.stop_reason === 'max_tokens') {
    throw new Error(
      'The summary was cut off before it finished. This transcript may be unusually long — ' +
        'try summarizing a shorter meeting.'
    );
  }

  const text = (body.content || []).find((block) => block.type === 'text')?.text;
  if (!text) throw new Error('Claude returned an empty response.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Claude returned a summary that was not valid JSON.');
  }
  return normalizeSummary(parsed);
}

async function describeHttpError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || '';
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
      return `Rate limited by Anthropic (429).${retry ? ` Retry in ${retry}s.` : ''} ${detail}`.trim();
    }
    default:
      if (response.status >= 500) {
        return `Anthropic had a server error (${response.status}). Try again shortly. ${detail}`.trim();
      }
      return `Anthropic API error ${response.status}. ${detail}`.trim();
  }
}
