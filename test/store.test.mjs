/** Meeting persistence: create, append, end, summarize, list, delete. */

import { check, installChromeStorageMock, section } from './harness.mjs';

export default async function run() {
  installChromeStorageMock();
  const store = await import('../src/store.js');

  section('meeting lifecycle');

  const meeting = await store.createMeeting({
    title: 'Standup',
    url: 'https://meet.google.com/abc-defg-hij',
  });
  check('returns a prefixed id', meeting.id.startsWith('m_'));
  check('marks the meeting active', (await store.getActiveMeetingId()) === meeting.id);
  check('adds it to the index', (await store.listMeetings()).some((m) => m.id === meeting.id));

  await store.appendLines(meeting.id, [{ speaker: 'You', text: 'morning', t: 100 }]);
  await store.appendLines(meeting.id, [
    { speaker: 'Others', text: 'hi', t: 200 },
    { speaker: 'You', text: 'lets start', t: 300 },
  ]);

  const withLines = await store.getMeeting(meeting.id);
  check('accumulates lines across calls', withLines.lines.length === 3);
  check(
    'keeps the index line count in step',
    (await store.listMeetings()).find((m) => m.id === meeting.id).lineCount === 3
  );
  check('appending nothing is a no-op', (await store.appendLines(meeting.id, [])) === 0);
  check(
    'flattens to speaker-prefixed text',
    store.transcriptText(withLines) === 'You: morning\nOthers: hi\nYou: lets start'
  );

  await store.endMeeting(meeting.id);
  check('clears the active meeting', (await store.getActiveMeetingId()) == null);
  check('records an end time', (await store.getMeeting(meeting.id)).endedAt != null);

  await store.saveSummary(
    meeting.id,
    { tldr: 'done', keyPoints: [], decisions: [], actionItems: [] },
    { provider: 'anthropic', model: 'claude-opus-5' }
  );
  check('persists the summary', (await store.getMeeting(meeting.id)).summary.tldr === 'done');
  check(
    'flags the summary in the index',
    (await store.listMeetings()).find((m) => m.id === meeting.id).hasSummary === true
  );

  section('listing and deletion');
  const second = await store.createMeeting({ title: 'Second' });
  await store.endMeeting(second.id);
  check('lists newest first', (await store.listMeetings())[0].id === second.id);

  await store.deleteMeeting(meeting.id);
  check('removes from the index', !(await store.listMeetings()).some((m) => m.id === meeting.id));
  check('removes the record', (await store.getMeeting(meeting.id)) == null);

  section('resilience');
  check('appending to a missing meeting is safe', (await store.appendLines('nope', [{ speaker: 'You', text: 'x' }])) === 0);
  check('summarizing a missing meeting is safe', (await store.saveSummary('nope', {}, {})) === null);
}
