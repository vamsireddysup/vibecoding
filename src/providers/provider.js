/**
 * Provider dispatch. Both adapters take the same arguments and resolve to the
 * same normalized shape, so nothing downstream branches on which one ran.
 */

import { askAnthropic, countTokensAnthropic, summarizeWithAnthropic } from './anthropic.js';
import { askOpenAI, countTokensOpenAI, summarizeWithOpenAI } from './openai.js';
import { isLocalEndpoint } from '../config.js';

const ADAPTERS = {
  anthropic: { summarize: summarizeWithAnthropic, ask: askAnthropic },
  openai: { summarize: summarizeWithOpenAI, ask: askOpenAI },
};

/** Input price per million tokens, for the estimate shown before a call. */
const INPUT_PRICE_PER_MTOK = {
  'claude-opus-5': 5,
  'claude-sonnet-5': 3,
  'claude-haiku-4-5': 1,
};

function adapterFor({ provider, apiKey, model, allowKeyless }) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unknown provider "${provider}".`);
  if (!apiKey && !allowKeyless) throw new Error('No API key configured.');
  if (!model) throw new Error('No model configured.');
  return adapter;
}

export async function summarize(options) {
  return adapterFor(options).summarize(options);
}

export async function askFollowUp(options) {
  if (!options.question?.trim()) throw new Error('Ask a question first.');
  return adapterFor(options).ask(options);
}

/**
 * What this call will cost, shown before it is made.
 *
 * For a tool whose whole premise is that the user owns the spend, seeing the
 * bill before authorizing it is the point. Anthropic has a free token-counting
 * endpoint, so that figure is exact; everywhere else it is a character-based
 * estimate and is labelled as one. Local endpoints cost nothing.
 */
export async function estimateCost({ provider, apiKey, model, baseUrl, transcript, title }) {
  if (provider === 'openai') {
    const tokens = countTokensOpenAI({ transcript, title });
    if (isLocalEndpoint(baseUrl)) {
      return { tokens, exact: false, cost: 0, note: 'Runs locally — no API charge.' };
    }
    return {
      tokens,
      exact: false,
      cost: null,
      note: 'Cost depends on your provider and model; this endpoint publishes no price list.',
    };
  }

  let tokens = null;
  try {
    tokens = await countTokensAnthropic({ apiKey, model, transcript, title });
  } catch {
    tokens = null; // never block summarizing because the estimate failed
  }

  const exact = tokens !== null;
  if (!exact) tokens = Math.ceil((transcript || '').length / 3.6);

  const price = INPUT_PRICE_PER_MTOK[model];
  return {
    tokens,
    exact,
    cost: price ? (tokens / 1e6) * price : null,
    note: price ? 'Input only; the summary itself adds a little more.' : 'Unknown price for this model.',
  };
}

/** Human-readable form of an estimate, for the button caption. */
export function formatEstimate(estimate) {
  if (!estimate) return '';
  const tokens =
    estimate.tokens >= 1000
      ? `${(estimate.tokens / 1000).toFixed(1)}K tokens`
      : `${estimate.tokens} tokens`;
  const prefix = estimate.exact ? '' : '~';
  if (estimate.cost === 0) return `${prefix}${tokens} · free`;
  if (estimate.cost == null) return `${prefix}${tokens}`;
  const cost = estimate.cost < 0.01 ? '<$0.01' : `$${estimate.cost.toFixed(2)}`;
  return `${prefix}${tokens} · ${cost}`;
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
    ...(record.lines || []).map((l) => `**${l.speaker}:** ${l.text}`),
    '',
  ].join('\n');
}
