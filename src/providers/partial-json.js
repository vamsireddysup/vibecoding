/**
 * Tolerant reader for JSON that is still arriving.
 *
 * Summaries are requested as structured JSON, so streamed deltas are not
 * readable prose — showing them raw would be worse than showing nothing. This
 * pulls the parts that are already complete out of a truncated payload so the
 * panel can render text as it streams, while the final, authoritative value
 * still comes from a real `JSON.parse` once the response finishes.
 *
 * Contract: never throws, whatever it is handed. Everything it returns is a
 * prefix of what the finished document will contain — it never guesses at a
 * value that is still mid-flight, because a half-written sentence that later
 * changes is worse than a slightly later one that does not.
 */

/**
 * Extract a completed top-level string field.
 * Returns null while the value is still being written.
 */
export function partialString(text, key) {
  const start = findValueStart(text, key);
  if (start === -1) return null;
  if (text[start] !== '"') return null;

  const { value, closed } = readString(text, start);
  return closed ? value : null;
}

/**
 * Extract the elements of a top-level array of strings that are already
 * complete. A half-written final element is omitted rather than shown.
 */
export function partialStringArray(text, key) {
  const start = findValueStart(text, key);
  if (start === -1 || text[start] !== '[') return [];

  const out = [];
  let i = start + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    if (i >= text.length || text[i] === ']') break;
    if (text[i] !== '"') break;
    const { value, closed, end } = readString(text, i);
    if (!closed) break;
    out.push(value);
    i = end;
  }
  return out;
}

/**
 * Extract the objects of a top-level array of objects that parse cleanly.
 * Used for action items, where a partial entry would show an empty task.
 */
export function partialObjectArray(text, key) {
  const start = findValueStart(text, key);
  if (start === -1 || text[start] !== '[') return [];

  const out = [];
  let i = start + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    if (i >= text.length || text[i] === ']') break;
    if (text[i] !== '{') break;

    const end = matchBrace(text, i);
    if (end === -1) break; // object still being written
    try {
      out.push(JSON.parse(text.slice(i, end)));
    } catch {
      break; // malformed rather than incomplete — stop, do not guess
    }
    i = end;
  }
  return out;
}

/** Everything renderable so far, in the summary's shape. */
export function partialSummary(text) {
  return {
    tldr: partialString(text, 'tldr') || '',
    keyPoints: partialStringArray(text, 'keyPoints'),
    decisions: partialStringArray(text, 'decisions'),
    actionItems: partialObjectArray(text, 'actionItems').filter(
      (item) => item && typeof item.task === 'string' && item.task.trim()
    ),
  };
}

// ------------------------------------------------------------------ helpers

/** Index just after `"key":`, or -1. Skips matches inside string values. */
function findValueStart(text, key) {
  const needle = `"${key}"`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return -1;
    if (!insideString(text, at)) {
      let i = at + needle.length;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] !== ':') return -1;
      i += 1;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      return i < text.length ? i : -1;
    }
    from = at + 1;
  }
}

/** Whether `index` sits inside a JSON string literal. */
function insideString(text, index) {
  let inside = false;
  for (let i = 0; i < index; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === '"') {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Read a JSON string starting at an opening quote.
 * `closed` distinguishes "finished" from "still streaming".
 */
function readString(text, start) {
  let out = '';
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
      } else {
        out += UNESCAPE[next] ?? next;
        i += 1;
      }
      continue;
    }
    if (ch === '"') return { value: out, closed: true, end: i + 1 };
    out += ch;
  }
  return { value: out, closed: false, end: text.length };
}

const UNESCAPE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

/** Index just past the object opened at `start`, or -1 if unterminated. */
function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
