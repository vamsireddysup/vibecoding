/**
 * Provider dispatch. Both adapters take the same arguments and resolve to the
 * same normalized shape, so nothing downstream branches on which one ran.
 */

import { summarizeWithAnthropic } from './anthropic.js';
import { summarizeWithOpenAI } from './openai.js';

const ADAPTERS = {
  anthropic: summarizeWithAnthropic,
  openai: summarizeWithOpenAI,
};

export async function summarize({ provider, apiKey, model, transcript, title }) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unknown provider "${provider}".`);
  if (!apiKey) throw new Error('No API key configured.');
  if (!model) throw new Error('No model configured.');
  return adapter({ apiKey, model, transcript, title });
}

/** Render a summary as Markdown for copy and export. */
export function summaryToMarkdown(record) {
  const s = record.summary;
  if (!s) return '';

  const when = new Date(record.startedAt).toLocaleString();
  const out = [`# ${record.title}`, '', `_${when}_`, '', '## Summary', '', s.tldr, ''];

  if (s.keyPoints.length) {
    out.push('## Key points', '');
    s.keyPoints.forEach((p) => out.push(`- ${p}`));
    out.push('');
  }

  if (s.decisions.length) {
    out.push('## Decisions', '');
    s.decisions.forEach((d) => out.push(`- ${d}`));
    out.push('');
  }

  if (s.actionItems.length) {
    out.push('## Action items', '');
    s.actionItems.forEach((a) => {
      const meta = [a.owner && `owner: ${a.owner}`, a.due && `due: ${a.due}`]
        .filter(Boolean)
        .join(', ');
      out.push(`- [ ] ${a.task}${meta ? ` _(${meta})_` : ''}`);
    });
    out.push('');
  }

  return out.join('\n');
}

/** Render the raw transcript as Markdown. */
export function transcriptToMarkdown(record) {
  const when = new Date(record.startedAt).toLocaleString();
  return [
    `# ${record.title} — transcript`,
    '',
    `_${when}_`,
    '',
    ...record.lines.map((l) => `**${l.speaker}:** ${l.text}`),
    '',
  ].join('\n');
}
