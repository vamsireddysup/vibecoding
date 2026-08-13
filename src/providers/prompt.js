/**
 * The system prompt and output schema, shared by both providers so a summary
 * does not silently change shape depending on which key the user pasted.
 */

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

/**
 * `anyOf` is used for nullable fields rather than a `["string","null"]` type
 * array: both Anthropic and OpenAI document anyOf as supported in strict mode,
 * whereas type-array nullability is only clearly specified by one of them.
 */
export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    tldr: {
      type: 'string',
      description: 'Two or three sentences capturing what this meeting was actually about.',
    },
    keyPoints: {
      type: 'array',
      items: { type: 'string' },
      description: 'The substantive discussion points, each a complete sentence.',
    },
    decisions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Decisions actually reached. Empty array if none were reached.',
    },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What needs to be done.' },
          owner: {
            ...nullableString,
            description: 'Who committed to it. Null unless the transcript says.',
          },
          due: {
            ...nullableString,
            description: 'Deadline as stated in the meeting. Null unless the transcript says.',
          },
        },
        required: ['task', 'owner', 'due'],
        additionalProperties: false,
      },
    },
  },
  required: ['tldr', 'keyPoints', 'decisions', 'actionItems'],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `
You summarize meeting transcripts.

The transcript comes from automatic speech recognition running on the user's own
machine. Expect its characteristic errors: missing or wrong punctuation, misheard
proper nouns and technical terms, dropped words, and occasional duplicated phrases
where the recognizer restarted. Read through these errors to the intended meaning.
Do not comment on transcript quality in your output.

Speakers are labelled only as "You" (the person running the extension) and
"Others" (everyone else on the call). Where someone states their own name, or is
addressed by name, you may use that name. Otherwise refer to people as "You" or
"a participant" — never guess which individual said something.

Rules that matter more than completeness:

- Report only what the transcript supports. If something was discussed
  inconclusively, say it was discussed, not that it was decided.
- An action item requires someone actually taking something on. A topic that
  merely came up is not an action item.
- Set "owner" to null unless the transcript makes the owner clear. Set "due" to
  null unless a deadline was actually stated. Inventing an owner or a date is
  the single worst thing you can do here, because the user will act on it.
- "decisions" and "actionItems" may be empty arrays. Many meetings genuinely
  produce neither, and padding them is worse than leaving them empty.

Write the way a colleague who attended would write up notes afterwards: plain,
specific sentences. No preamble, no meta-commentary, no filler.
`.trim();

export function buildUserMessage({ title, transcript }) {
  return [
    title ? `Meeting: ${title}` : null,
    '',
    'Transcript:',
    transcript,
  ]
    .filter((part) => part !== null)
    .join('\n');
}

/**
 * Validate and normalize a parsed model response. Structured outputs make the
 * shape very likely correct, but a missing key here would surface as a confusing
 * render error in the panel, so normalize rather than trust.
 */
export function normalizeSummary(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('The model returned an unreadable summary.');
  }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  return {
    tldr: typeof raw.tldr === 'string' ? raw.tldr.trim() : '',
    keyPoints: list(raw.keyPoints),
    decisions: list(raw.decisions),
    actionItems: Array.isArray(raw.actionItems)
      ? raw.actionItems
          .filter((item) => item && typeof item.task === 'string' && item.task.trim())
          .map((item) => ({
            task: item.task.trim(),
            owner: typeof item.owner === 'string' && item.owner.trim() ? item.owner.trim() : null,
            due: typeof item.due === 'string' && item.due.trim() ? item.due.trim() : null,
          }))
      : [],
  };
}
