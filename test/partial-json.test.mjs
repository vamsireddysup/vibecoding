/**
 * The tolerant reader used to render streamed summaries as they arrive.
 *
 * Two properties matter more than any single case: it must never throw on a
 * truncated payload, and it must never surface a value that is still being
 * written. Showing half a sentence that then changes is worse than showing it a
 * moment later, so the "every prefix is safe" sweep below is the real test.
 */

import { check, section } from './harness.mjs';
import {
  partialObjectArray,
  partialString,
  partialStringArray,
  partialSummary,
} from '../src/providers/partial-json.js';

const FULL = JSON.stringify({
  tldr: 'We agreed to ship on Friday if CI is green.',
  keyPoints: ['Latency is the top complaint', 'Docs are stale'],
  decisions: ['Ship Friday'],
  actionItems: [
    { task: 'Draft the RFC', owner: 'Priya', due: 'Friday' },
    { task: 'Fix the flaky test', owner: null, due: null },
  ],
});

export default async function run() {
  section('complete payloads');
  check('reads a string field', partialString(FULL, 'tldr').startsWith('We agreed'));
  check('reads a string array', partialStringArray(FULL, 'keyPoints').length === 2);
  check('reads an object array', partialObjectArray(FULL, 'actionItems').length === 2);
  check('assembles the whole summary', partialSummary(FULL).actionItems[0].owner === 'Priya');

  section('values still being written');
  const midString = '{"tldr": "We agreed to shi';
  check('withholds an unterminated string', partialString(midString, 'tldr') === null);
  check('summary tolerates it', partialSummary(midString).tldr === '');

  const midArray = '{"tldr":"x","keyPoints":["Latency is the top complaint","Docs are st';
  const points = partialStringArray(midArray, 'keyPoints');
  check('returns the completed array elements', points.length === 1);
  check('omits the element still in flight', points[0] === 'Latency is the top complaint');

  const midObject = '{"actionItems":[{"task":"Draft the RFC","owner":"Priya","due":"Friday"},{"task":"Fix';
  const items = partialObjectArray(midObject, 'actionItems');
  check('returns completed objects only', items.length === 1 && items[0].task === 'Draft the RFC');

  section('never throws, and never lies');
  // Every prefix of a real payload must be safe and consistent with the end state.
  let threw = null;
  let regressed = null;
  for (let i = 0; i <= FULL.length; i += 1) {
    const prefix = FULL.slice(0, i);
    let out;
    try {
      out = partialSummary(prefix);
    } catch (err) {
      threw = `${i}: ${err.message}`;
      break;
    }
    const finalSummary = partialSummary(FULL);
    if (out.tldr && !finalSummary.tldr.startsWith(out.tldr)) regressed = `tldr at ${i}`;
    if (out.keyPoints.some((p, n) => finalSummary.keyPoints[n] !== p)) regressed = `keyPoints at ${i}`;
    if (out.actionItems.some((a, n) => finalSummary.actionItems[n]?.task !== a.task)) {
      regressed = `actionItems at ${i}`;
    }
  }
  check(`survives all ${FULL.length} prefixes without throwing`, threw === null, threw || '');
  check('every partial value is a prefix of the final one', regressed === null, regressed || '');

  section('hostile input');
  const cases = ['', '{', '[]', 'null', '{"tldr":', '{"tldr":}', 'not json at all', '{"tldr":"a\\', '{"a":{"tldr":"nested"}}'];
  let hostileThrew = null;
  for (const input of cases) {
    try {
      partialSummary(input);
    } catch (err) {
      hostileThrew = `${JSON.stringify(input)}: ${err.message}`;
    }
  }
  check('malformed input never throws', hostileThrew === null, hostileThrew || '');

  check(
    'escapes are decoded',
    partialString('{"tldr":"line one\\nline \\"two\\""}', 'tldr') === 'line one\nline "two"'
  );
  check(
    'a key inside a string value is not mistaken for the field',
    partialString('{"other":"contains \\"tldr\\": fake","tldr":"real"}', 'tldr') === 'real'
  );
  check('a missing field yields null', partialString('{"a":1}', 'tldr') === null);
  check('a missing array yields empty', partialStringArray('{"a":1}', 'keyPoints').length === 0);
}
