/**
 * Restart-boundary deduplication.
 *
 * The risk cuts both ways: too eager and it eats real speech, too lax and
 * duplicated phrases reach the summary. The cases below pin both edges.
 */

import { check, section } from './harness.mjs';
import { dropOverlap } from '../src/capture/dedupe.js';

export default async function run() {
  section('restart artifacts');
  check(
    'strips a repeated opening',
    dropOverlap(
      'so I think we should ship on Friday',
      'we should ship on Friday if the tests pass'
    ) === 'if the tests pass'
  );
  check(
    'drops a wholly repeated phrase',
    dropOverlap('we should ship on Friday', 'we should ship on Friday') === ''
  );
  check(
    'drops a repeat that is a subset of the previous line',
    dropOverlap('okay so we should ship on Friday next week', 'should ship on Friday') === ''
  );
  check(
    'ignores punctuation and case differences',
    dropOverlap('We should ship on Friday.', 'we should ship on friday, if tests pass') ===
      'if tests pass'
  );

  section('genuine speech survives');
  check(
    'unrelated text passes through',
    dropOverlap('we should ship on Friday', 'what about the docs') === 'what about the docs'
  );
  check(
    'a short coincidental overlap is kept',
    dropOverlap('that works for me', 'for me the blocker is CI') === 'for me the blocker is CI'
  );
  check(
    'a phrase repeated later in the sentence is kept',
    dropOverlap('the tests pass', 'I will check whether the tests pass') ===
      'I will check whether the tests pass'
  );
  check('no previous line means no change', dropOverlap('', 'first thing said') === 'first thing said');
  check('empty new text is unchanged', dropOverlap('anything', '') === '');

  section('preserves the original text');
  const out = dropOverlap('we should ship', 'we should ship — and document it properly');
  check('keeps punctuation and casing of what remains', out === 'and document it properly', out);
}
