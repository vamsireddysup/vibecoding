/**
 * Drop text the recognizer re-emits after a restart.
 *
 * The restart loop that keeps transcription alive across silence and transient
 * errors has a cost: when a recognizer dies mid-sentence, the replacement often
 * re-reports words the previous one already finalized. Left alone that puts
 * duplicated phrases in the transcript, and duplicated phrases in a transcript
 * become duplicated points in the summary — the error compounds into the output
 * the user actually reads.
 *
 * Comparison is on normalized words, because the two emissions rarely agree on
 * punctuation or capitalization even when the words match.
 */

/** Below this, a repeat is more likely genuine speech than a restart artifact. */
const MIN_OVERLAP_WORDS = 3;

/** Overlaps longer than this are not plausible restart artifacts. */
const MAX_OVERLAP_WORDS = 40;

const normalize = (text) =>
  (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Return `text` with any leading repeat of the tail of `previous` removed, or
 * an empty string if the whole thing is a repeat.
 *
 * Only the *start* of the new text is considered: a phrase repeated later in a
 * meeting is someone genuinely saying it again, and must survive.
 */
export function dropOverlap(previous, text) {
  const prevWords = normalize(previous);
  const nextWords = normalize(text);
  if (!prevWords.length || !nextWords.length) return text;

  // Whole utterance already recorded — most common right after a restart.
  if (nextWords.length <= MAX_OVERLAP_WORDS && containsRun(prevWords, nextWords)) return '';

  const limit = Math.min(prevWords.length, nextWords.length, MAX_OVERLAP_WORDS);
  for (let size = limit; size >= MIN_OVERLAP_WORDS; size -= 1) {
    const tail = prevWords.slice(prevWords.length - size);
    const head = nextWords.slice(0, size);
    if (tail.every((word, i) => word === head[i])) {
      return sliceAfterWords(text, size);
    }
  }
  return text;
}

/** Whether `needle` appears as a contiguous run inside `haystack`. */
function containsRun(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((word, i) => haystack[start + i] === word)) return true;
  }
  return false;
}

/**
 * Drop the first `count` words from the original text, preserving the original
 * punctuation and spacing of what remains — normalization is only ever used for
 * comparison, never for what gets stored.
 */
function sliceAfterWords(text, count) {
  let seen = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const isWordChar = /[\p{L}\p{N}']/u.test(text[i]);
    if (isWordChar && !inWord) {
      inWord = true;
      seen += 1;
    } else if (!isWordChar && inWord) {
      inWord = false;
      // Strip whatever punctuation joined the two halves — em dashes and
      // ellipses show up here as often as commas, so match the category
      // rather than listing characters.
      if (seen === count) return text.slice(i).replace(/^[\s\p{P}\p{S}]+/u, '');
    }
  }
  return seen <= count ? '' : text;
}
