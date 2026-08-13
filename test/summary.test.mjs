/** Summary normalization, schema shape, and Markdown rendering. */

import { check, rejects, section } from './harness.mjs';
import { SUMMARY_SCHEMA, buildUserMessage, normalizeSummary } from '../src/providers/prompt.js';
import { summarize, summaryToMarkdown, transcriptToMarkdown } from '../src/providers/provider.js';

export default async function run() {
  section('summary normalization');

  const cleaned = normalizeSummary({
    tldr: '  Discussed the Q3 roadmap.  ',
    keyPoints: ['Latency is the top complaint', '', 42, 'Docs are stale'],
    decisions: [],
    actionItems: [
      { task: ' Draft the RFC ', owner: 'Priya', due: 'Friday' },
      { task: 'Fix the flaky test', owner: '', due: null },
      { task: '', owner: 'X', due: 'Y' },
      null,
    ],
  });

  check('trims the tldr', cleaned.tldr === 'Discussed the Q3 roadmap.');
  check('drops empty and non-string key points', cleaned.keyPoints.length === 2);
  check('keeps an empty decisions array', cleaned.decisions.length === 0);
  check('drops action items with no task', cleaned.actionItems.length === 2);
  check('turns a blank owner into null', cleaned.actionItems[1].owner === null);
  check('keeps a stated owner and due date', cleaned.actionItems[0].owner === 'Priya');

  const sparse = normalizeSummary({ tldr: 'x' });
  check('tolerates missing arrays', sparse.keyPoints.length === 0);
  check('rejects a null response', Boolean(await rejects(Promise.reject(tryNormalize(null)))));
  check('rejects a non-object response', Boolean(tryNormalize('nope')));

  section('output schema');
  check('top level forbids extra properties', SUMMARY_SCHEMA.additionalProperties === false);
  check(
    'every top-level property is required',
    SUMMARY_SCHEMA.required.length === Object.keys(SUMMARY_SCHEMA.properties).length
  );
  const item = SUMMARY_SCHEMA.properties.actionItems.items;
  check('action items require task, owner and due', item.required.join(',') === 'task,owner,due');
  check('nullable fields use anyOf', Array.isArray(item.properties.owner.anyOf));
  check('schema serializes', typeof JSON.stringify(SUMMARY_SCHEMA) === 'string');

  section('markdown rendering');
  const record = {
    id: 'm1',
    title: 'Roadmap sync',
    startedAt: Date.UTC(2026, 7, 13, 15, 0),
    endedAt: Date.UTC(2026, 7, 13, 15, 30),
    lines: [
      { speaker: 'You', text: 'Can we ship Friday?' },
      { speaker: 'Others', text: 'Only if CI is green.' },
    ],
    summary: cleaned,
    summaryMeta: { provider: 'anthropic', model: 'claude-opus-5', at: Date.now() },
  };

  const md = summaryToMarkdown(record);
  check('includes the meeting title', md.includes('# Roadmap sync'));
  check('renders action items as checkboxes', md.includes('- [ ] Draft the RFC'));
  check('annotates owner and due date', md.includes('_(owner: Priya, due: Friday)_'));
  check('omits the section when there are no decisions', !md.includes('## Decisions'));
  check('returns empty string with no summary', summaryToMarkdown({ summary: null }) === '');

  const transcript = transcriptToMarkdown(record);
  check('transcript labels both speakers', transcript.includes('**You:**') && transcript.includes('**Others:**'));

  section('provider dispatch');
  check(
    'rejects an unknown provider',
    /Unknown provider/.test(await rejects(summarize({ provider: 'nope', apiKey: 'k', model: 'm' })))
  );
  check(
    'rejects a missing key',
    /No API key/.test(await rejects(summarize({ provider: 'anthropic', apiKey: '', model: 'm' })))
  );
  check(
    'rejects a missing model',
    /No model/.test(await rejects(summarize({ provider: 'openai', apiKey: 'k', model: '' })))
  );

  section('prompt assembly');
  check('embeds the transcript', buildUserMessage({ title: 'T', transcript: 'hello' }).includes('hello'));
  check('works without a title', !buildUserMessage({ transcript: 'x' }).startsWith('Meeting:'));
}

function tryNormalize(value) {
  try {
    normalizeSummary(value);
    return null;
  } catch (err) {
    return err;
  }
}
