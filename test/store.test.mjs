/**
 * Meeting persistence, including the chunking that keeps appends flat.
 *
 * The benchmark at the end is the regression guard for the whole reason
 * chunking exists: the previous design was quadratic, and a future refactor
 * that reintroduced a whole-transcript rewrite would pass every other assertion
 * here while silently making long meetings slow again.
 */

import { check, installChromeStorageMock, section } from './harness.mjs';

const line = (i, speaker = 'Others') => ({
  speaker,
  text: `line number ${i} with a realistic amount of words in it`,
  t: i * 3000,
  at: 1700000000000 + i * 3000,
});

export default async function run() {
  const mem = installChromeStorageMock();
  const store = await import('../src/store.js');
  const { CHUNK_SIZE } = store;

  section('meeting lifecycle');
  const meeting = await store.createMeeting({ title: 'Standup', url: 'https://meet.google.com/x' });
  check('returns a prefixed id', meeting.id.startsWith('m_'));
  check('marks the meeting active', (await store.getActiveMeetingId()) === meeting.id);
  check('adds it to the index', (await store.listMeetings()).some((m) => m.id === meeting.id));

  await store.appendLines(meeting.id, [line(0, 'You')]);
  await store.appendLines(meeting.id, [line(1), line(2, 'You')]);
  check('accumulates across calls', (await store.getLines(meeting.id)).length === 3);
  check('tracks the count on the record', (await store.getMeeting(meeting.id)).lineCount === 3);
  check(
    'keeps the index count in step',
    (await store.listMeetings()).find((m) => m.id === meeting.id).lineCount === 3
  );
  check('appending nothing is a no-op', (await store.appendLines(meeting.id, [])) === 0);
  check(
    'flattens to speaker-prefixed text',
    store.transcriptText(await store.getLines(meeting.id)).split('\n').length === 3
  );

  section('chunking');
  check(
    'metadata carries no lines array',
    !Array.isArray((await store.getMeeting(meeting.id)).lines)
  );

  const big = await store.createMeeting({ title: 'Long' });
  const total = CHUNK_SIZE * 2 + 5;
  for (let i = 0; i < total; i += 1) await store.appendLines(big.id, [line(i)]);

  const record = await store.getMeeting(big.id);
  check(`splits ${total} lines into 3 chunks`, record.chunkCount === 3, String(record.chunkCount));
  check('counts every line', record.lineCount === total);

  const read = await store.getLines(big.id);
  check('reads every line back', read.length === total);
  check(
    'preserves order across chunk boundaries',
    read[0].t === 0 && read[total - 1].t === (total - 1) * 3000
  );
  check(
    'no chunk exceeds CHUNK_SIZE',
    Array.from({ length: record.chunkCount }, (_, n) => mem[`meeting:${big.id}:c${n}`]).every(
      (c) => c.length <= CHUNK_SIZE
    )
  );

  // A batch that straddles a boundary is the case a naive implementation drops.
  const batch = await store.createMeeting({ title: 'Batch' });
  await store.appendLines(batch.id, Array.from({ length: CHUNK_SIZE - 2 }, (_, i) => line(i)));
  await store.appendLines(batch.id, Array.from({ length: 5 }, (_, i) => line(1000 + i)));
  check(
    'a multi-line append spanning a boundary keeps every line',
    (await store.getLines(batch.id)).length === CHUNK_SIZE + 3
  );

  section('speaker aliases');
  await store.setSpeakerAlias(meeting.id, 'Others', 'Priya');
  const aliased = await store.getLines(meeting.id);
  check('rename applies on read', aliased.some((l) => l.speaker === 'Priya'));
  check('leaves other speakers alone', aliased.some((l) => l.speaker === 'You'));
  check(
    'chunks are not rewritten',
    mem[`meeting:${meeting.id}:c0`].every((l) => l.speaker !== 'Priya')
  );
  check(
    'lists raw labels with their alias',
    (await store.listSpeakers(meeting.id)).some((s) => s.label === 'Others' && s.alias === 'Priya')
  );
  await store.setSpeakerAlias(meeting.id, 'Others', '');
  check(
    'an empty name clears the alias',
    (await store.getLines(meeting.id)).some((l) => l.speaker === 'Others')
  );

  section('legacy records');
  // Written by the pre-chunking version; must still read after an upgrade.
  mem['meeting:legacy'] = {
    id: 'legacy',
    title: 'Old meeting',
    startedAt: 1,
    endedAt: 2,
    lines: [{ speaker: 'You', text: 'hello from before chunking' }],
    speakerAliases: {},
  };
  check('reads inline lines from an old record', (await store.getLines('legacy')).length === 1);
  check('lists speakers from an old record', (await store.listSpeakers('legacy')).length === 1);

  section('summary, chat and deletion');
  await store.saveSummary(
    meeting.id,
    { tldr: 'done' },
    { provider: 'anthropic', model: 'claude-opus-5' }
  );
  check('persists the summary', (await store.getMeeting(meeting.id)).summary.tldr === 'done');
  check(
    'flags the summary in the index',
    (await store.listMeetings()).find((m) => m.id === meeting.id).hasSummary === true
  );

  await store.appendChat(meeting.id, [{ role: 'user', content: 'who owns the RFC?' }]);
  check('appends chat history', (await store.getMeeting(meeting.id)).chat.length === 1);

  const withLines = await store.getMeetingWithLines(meeting.id);
  check(
    'getMeetingWithLines returns metadata and lines together',
    withLines.lines.length === 3 && Boolean(withLines.summary)
  );

  await store.endMeeting(meeting.id);
  check('clears the active meeting', (await store.getActiveMeetingId()) == null);

  await store.deleteMeeting(big.id);
  check('delete removes the record', (await store.getMeeting(big.id)) == null);
  check(
    'delete removes every chunk key',
    !Object.keys(mem).some((k) => k.startsWith(`meeting:${big.id}:c`))
  );
  check('delete removes it from the index', !(await store.listMeetings()).some((m) => m.id === big.id));

  section('resilience');
  check('appending to a missing meeting is safe', (await store.appendLines('nope', [line(1)])) === 0);
  check('summarizing a missing meeting is safe', (await store.saveSummary('nope', {}, {})) === null);
  check('reading a missing meeting is safe', (await store.getLines('nope')).length === 0);

  section('append cost stays flat');
  const perLine = [];
  for (const n of [200, 2000]) {
    for (const k of Object.keys(mem)) delete mem[k];
    const m = await store.createMeeting({ title: 'bench' });
    const started = performance.now();
    for (let i = 0; i < n; i += 1) await store.appendLines(m.id, [line(i)]);
    perLine.push((performance.now() - started) / n);
  }
  const ratio = perLine[1] / perLine[0];
  check(
    `per-line cost does not grow with length (${perLine[0].toFixed(3)} -> ${perLine[1].toFixed(3)} ms/line)`,
    ratio < 3,
    `${ratio.toFixed(2)}x — a whole-transcript rewrite may have been reintroduced`
  );
}
