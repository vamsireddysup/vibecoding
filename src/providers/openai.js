/**
 * OpenAI Chat Completions, called directly from the browser.
 *
 * No special CORS header is needed here — api.openai.com serves cross-origin
 * requests. As with Anthropic, the key is the user's own and stays in their
 * browser profile.
 *
 * No token limit is sent deliberately: OpenAI renamed `max_tokens` to
 * `max_completion_tokens` on newer models, and sending the wrong one is a hard
 * 400. Omitting both lets every model apply its own default and keeps this file
 * working across model generations.
 */

import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, normalizeSummary } from './prompt.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export async function summarizeWithOpenAI({ apiKey, model, transcript, title }) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage({ title, transcript }) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'meeting_summary',
            strict: true,
            schema: SUMMARY_SCHEMA,
          },
        },
      }),
    });
  } catch (err) {
    throw new Error(`Could not reach the OpenAI API: ${err?.message || err}`);
  }

  if (!response.ok) throw new Error(await describeHttpError(response));

  const body = await response.json();
  const choice = body.choices?.[0];

  if (choice?.finish_reason === 'length') {
    throw new Error(
      'The summary was cut off before it finished. This transcript may be unusually long — ' +
        'try summarizing a shorter meeting.'
    );
  }

  if (choice?.message?.refusal) {
    throw new Error(`The model declined to summarize this transcript: ${choice.message.refusal}`);
  }

  const text = choice?.message?.content;
  if (!text) throw new Error('OpenAI returned an empty response.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('OpenAI returned a summary that was not valid JSON.');
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
      return `OpenAI rejected your API key (401). Check the key in Settings. ${detail}`.trim();
    case 403:
      return `Your OpenAI key lacks permission for this request (403). ${detail}`.trim();
    case 404:
      return (
        'Model not found (404). Check the model name in Settings — your account ' +
        `may not have access to it. ${detail}`
      ).trim();
    case 400:
      // Most often an unsupported model name or a schema the model can't honor.
      return `OpenAI rejected the request (400). ${detail}`.trim();
    case 429:
      return `Rate limited or out of quota on OpenAI (429). ${detail}`.trim();
    default:
      if (response.status >= 500) {
        return `OpenAI had a server error (${response.status}). Try again shortly. ${detail}`.trim();
      }
      return `OpenAI API error ${response.status}. ${detail}`.trim();
  }
}
