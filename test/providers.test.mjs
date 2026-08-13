/**
 * Provider request shape and error handling.
 *
 * The most important assertion in this file is that the Anthropic request
 * carries `anthropic-dangerous-direct-browser-access`. Without it every
 * browser-side call is blocked by CORS and the extension cannot summarize
 * anything at all.
 */

import { check, installFetchMock, rejects, section } from './harness.mjs';
import { summarizeWithAnthropic } from '../src/providers/anthropic.js';
import { summarizeWithOpenAI } from '../src/providers/openai.js';

const VALID_SUMMARY = {
  tldr: 'Shipped it.',
  keyPoints: ['a'],
  decisions: ['ship'],
  actionItems: [{ task: 'deploy', owner: null, due: null }],
};

export default async function run() {
  const http = installFetchMock();

  section('anthropic request shape');
  http.reply(200, {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(VALID_SUMMARY) }],
  });

  const result = await summarizeWithAnthropic({
    apiKey: 'sk-ant-test',
    model: 'claude-opus-5',
    transcript: 'You: hi',
    title: 'T',
  });

  const { headers, body, url } = http.last;
  check('sends the browser-access CORS header', headers['anthropic-dangerous-direct-browser-access'] === 'true');
  check('sends the API version', headers['anthropic-version'] === '2023-06-01');
  check('authenticates with x-api-key', headers['x-api-key'] === 'sk-ant-test' && !headers.authorization);
  check('posts to the messages endpoint', url === 'https://api.anthropic.com/v1/messages');
  check('forwards the selected model', body.model === 'claude-opus-5');
  check('requests structured output', body.output_config.format.type === 'json_schema');
  check('leaves headroom for thinking tokens', body.max_tokens >= 16000);
  check('omits sampling params rejected by Opus 5', !('temperature' in body) && !('top_p' in body));
  check('omits budget_tokens rejected by Opus 5', !JSON.stringify(body).includes('budget_tokens'));
  check('parses the summary', result.tldr === 'Shipped it.' && result.actionItems[0].task === 'deploy');

  section('anthropic failure modes');
  http.reply(200, { stop_reason: 'refusal', stop_details: { explanation: 'policy' }, content: [] });
  check(
    'checks refusal before reading content',
    /declined/i.test(await rejects(call(summarizeWithAnthropic)))
  );

  http.reply(200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"tldr"' }] });
  check('reports truncation plainly', /cut off/i.test(await rejects(call(summarizeWithAnthropic))));

  http.reply(401, { error: { message: 'invalid x-api-key' } });
  const unauthorized = await rejects(call(summarizeWithAnthropic));
  check('401 points at the key and Settings', /401/.test(unauthorized) && /Settings/.test(unauthorized));

  http.reply(429, { error: { message: 'slow down' } }, { 'retry-after': '30' });
  check('429 surfaces retry-after', /30s/.test(await rejects(call(summarizeWithAnthropic))));

  http.reply(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] });
  check('reports unparseable JSON', /not valid JSON/i.test(await rejects(call(summarizeWithAnthropic))));

  http.failWith('network down');
  check('reports a network failure', /Could not reach/.test(await rejects(call(summarizeWithAnthropic))));

  section('openai request shape');
  http.reply(200, {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(VALID_SUMMARY) } }],
  });
  const openaiResult = await summarizeWithOpenAI({
    apiKey: 'sk-oai',
    model: 'gpt-5',
    transcript: 'You: hi',
    title: 'T',
  });
  check('authenticates with a bearer token', http.last.headers.authorization === 'Bearer sk-oai');
  check('posts to chat completions', http.last.url === 'https://api.openai.com/v1/chat/completions');
  check('requests a strict json schema', http.last.body.response_format.json_schema.strict === true);
  check(
    'omits both token-limit spellings',
    !('max_tokens' in http.last.body) && !('max_completion_tokens' in http.last.body)
  );
  check('parses the summary', openaiResult.tldr === 'Shipped it.');

  section('openai failure modes');
  http.reply(200, { choices: [{ finish_reason: 'stop', message: { refusal: 'nope' } }] });
  check('handles a refusal', /declined/i.test(await rejects(call(summarizeWithOpenAI))));

  http.reply(200, { choices: [{ finish_reason: 'length', message: { content: '{' } }] });
  check('reports truncation plainly', /cut off/i.test(await rejects(call(summarizeWithOpenAI))));

  http.reply(404, { error: { message: 'model does not exist' } });
  check('404 points at the model setting', /model name in Settings/i.test(await rejects(call(summarizeWithOpenAI))));
}

const call = (fn) => fn({ apiKey: 'k', model: 'm', transcript: 't', title: 'T' });
