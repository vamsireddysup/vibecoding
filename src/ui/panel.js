/**
 * Side panel UI.
 *
 * All state lives in the service worker; this file asks for it and renders it.
 * Transcript text is always inserted with textContent — it comes from speech
 * recognition of arbitrary audio and must never be parsed as HTML.
 */

import { summaryToMarkdown, transcriptToMarkdown } from '../providers/provider.js';

const $ = (id) => document.getElementById(id);

const el = {
  record: $('record'),
  status: $('status'),
  alerts: $('alerts'),
  openSettings: $('open-settings'),

  viewList: $('view-list'),
  meetingList: $('meeting-list'),
  emptyList: $('empty-list'),

  viewMeeting: $('view-meeting'),
  back: $('back'),
  meetingTitle: $('meeting-title'),
  meetingMeta: $('meeting-meta'),

  tabTranscript: $('tab-transcript'),
  tabSummary: $('tab-summary'),
  paneTranscript: $('pane-transcript'),
  paneSummary: $('pane-summary'),

  transcript: $('transcript'),
  transcriptEmpty: $('transcript-empty'),

  summarize: $('summarize'),
  summaryHint: $('summary-hint'),
  summary: $('summary'),

  copy: $('copy'),
  exportSummary: $('export-summary'),
  exportTranscript: $('export-transcript'),
  del: $('delete'),
};

let recording = false;
let activeMeetingId = null;
let openMeeting = null; // full record of the meeting being viewed
let interimEls = {};

// ------------------------------------------------------------ messaging

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    target: 'panel-request',
    type,
    ...payload,
  });
  if (!response) throw new Error('The extension background did not respond. Try reopening the panel.');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'panel') return;

  if (message.type === 'LINE') {
    if (openMeeting && openMeeting.id === activeMeetingId) appendLine(message.line);
    return;
  }

  if (message.type === 'STATE') {
    recording = message.recording;
    activeMeetingId = message.meetingId;
    (message.warnings || []).forEach((w) => alert_(w, false));
    renderRecordBar();
    return;
  }

  if (message.type === 'WARNING') {
    alert_(message.message, message.fatal);
  }
});

// -------------------------------------------------------------- alerts

function alert_(text, isError) {
  const box = document.createElement('div');
  box.className = `alert${isError ? ' is-error' : ''}`;
  box.textContent = text;

  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Dismiss';
  close.addEventListener('click', () => box.remove());
  box.appendChild(close);

  el.alerts.appendChild(box);
}

function clearAlerts() {
  el.alerts.replaceChildren();
}

// -------------------------------------------------------------- record

function renderRecordBar() {
  el.record.textContent = recording ? 'Stop recording' : 'Start recording';
  el.record.classList.toggle('is-recording', recording);
  el.status.textContent = recording ? 'Recording' : 'Idle';
  el.status.classList.toggle('is-live', recording);
}

el.record.addEventListener('click', async () => {
  el.record.disabled = true;
  clearAlerts();
  try {
    if (recording) {
      await request('STOP');
      recording = false;
      activeMeetingId = null;
      if (openMeeting) await showMeeting(openMeeting.id);
      await refreshList();
    } else {
      const { meetingId, warnings } = await request('START');
      recording = true;
      activeMeetingId = meetingId;
      (warnings || []).forEach((w) => alert_(w, false));
      await refreshList();
      await showMeeting(meetingId);
    }
  } catch (err) {
    alert_(String(err.message || err), true);
  } finally {
    el.record.disabled = false;
    renderRecordBar();
  }
});

el.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ------------------------------------------------------------- meetings

async function refreshList() {
  const meetings = await request('LIST_MEETINGS');
  el.meetingList.replaceChildren();
  el.emptyList.hidden = meetings.length > 0;

  for (const m of meetings) {
    const li = document.createElement('li');
    const button = document.createElement('button');

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = m.title || 'Untitled meeting';

    const sub = document.createElement('span');
    sub.className = 'sub';
    const parts = [new Date(m.startedAt).toLocaleString(), `${m.lineCount || 0} lines`];
    if (m.hasSummary) parts.push('summarized');
    if (!m.endedAt) parts.push('in progress');
    sub.textContent = parts.join(' · ');

    button.append(title, sub);
    button.addEventListener('click', () => showMeeting(m.id));
    li.appendChild(button);
    el.meetingList.appendChild(li);
  }
}

function showList() {
  openMeeting = null;
  el.viewList.hidden = false;
  el.viewMeeting.hidden = true;
  refreshList();
}

async function showMeeting(id) {
  openMeeting = await request('GET_MEETING', { meetingId: id });
  if (!openMeeting) return showList();

  el.viewList.hidden = true;
  el.viewMeeting.hidden = false;

  el.meetingTitle.textContent = openMeeting.title;
  const started = new Date(openMeeting.startedAt).toLocaleString();
  const duration = openMeeting.endedAt
    ? formatDuration(openMeeting.endedAt - openMeeting.startedAt)
    : 'in progress';
  el.meetingMeta.textContent = `${started} · ${duration}`;

  renderTranscript();
  renderSummary();
  selectTab('transcript');
}

el.back.addEventListener('click', showList);

el.del.addEventListener('click', async () => {
  if (!openMeeting) return;
  if (openMeeting.id === activeMeetingId) {
    return alert_('Stop the recording before deleting this meeting.', true);
  }
  await request('DELETE_MEETING', { meetingId: openMeeting.id });
  showList();
});

// ----------------------------------------------------------- transcript

function renderTranscript() {
  el.transcript.replaceChildren();
  interimEls = {};
  // `track: false` — these lines are already in openMeeting.lines; re-adding
  // them here would duplicate the whole transcript on every re-render.
  openMeeting.lines.forEach((line) => appendLine(line, { autoscroll: false, track: false }));
  el.transcriptEmpty.hidden = openMeeting.lines.length > 0;
}

function lineNode(line) {
  const row = document.createElement('div');
  row.className = `line ${line.speaker === 'You' ? 'you' : 'others'}${line.interim ? ' interim' : ''}`;

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = line.speaker;

  const what = document.createElement('span');
  what.className = 'what';
  what.textContent = line.text;

  row.append(who, what);
  return row;
}

/**
 * Interim results are volatile: each speaker gets at most one interim row,
 * replaced in place until the phrase goes final.
 *
 * `track` controls whether a final line is also pushed into the in-memory
 * record. Live lines arriving from the service worker need it (so Copy and
 * Export see them without a round trip); lines being replayed from storage
 * during a re-render must not have it, or the transcript doubles.
 */
function appendLine(line, { autoscroll = true, track = true } = {}) {
  const existingInterim = interimEls[line.speaker];
  if (existingInterim) {
    existingInterim.remove();
    delete interimEls[line.speaker];
  }

  const node = lineNode(line);
  el.transcript.appendChild(node);

  if (line.interim) interimEls[line.speaker] = node;
  else if (track && openMeeting) openMeeting.lines.push(line);

  el.transcriptEmpty.hidden = true;
  if (autoscroll) node.scrollIntoView({ block: 'end' });
}

// -------------------------------------------------------------- summary

function renderSummary() {
  el.summary.replaceChildren();
  const s = openMeeting.summary;

  if (!s) {
    el.summaryHint.textContent = openMeeting.lines.length
      ? 'Uses your own API key. Nothing is sent until you press the button.'
      : 'Record something first — there is no transcript to summarize yet.';
    el.summarize.disabled = openMeeting.lines.length === 0;
    return;
  }

  const meta = openMeeting.summaryMeta;
  el.summaryHint.textContent = meta
    ? `Generated with ${meta.model} on ${new Date(meta.at).toLocaleString()}.`
    : '';
  el.summarize.disabled = false;
  el.summarize.textContent = 'Regenerate summary';

  if (s.tldr) {
    el.summary.append(heading('Summary'), paragraph(s.tldr));
  }
  if (s.keyPoints.length) {
    el.summary.append(heading('Key points'), bulletList(s.keyPoints));
  }
  if (s.decisions.length) {
    el.summary.append(heading('Decisions'), bulletList(s.decisions));
  }
  if (s.actionItems.length) {
    el.summary.append(heading('Action items'), actionList(s.actionItems));
  }
  if (!s.decisions.length && !s.actionItems.length) {
    el.summary.append(paragraph('No decisions or action items were recorded in this meeting.'));
  }
}

function heading(text) {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

function paragraph(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

function bulletList(items) {
  const ul = document.createElement('ul');
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  });
  return ul;
}

function actionList(items) {
  const ul = document.createElement('ul');
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.task;
    const bits = [item.owner && `owner: ${item.owner}`, item.due && `due: ${item.due}`].filter(
      Boolean
    );
    if (bits.length) {
      const span = document.createElement('span');
      span.className = 'owner';
      span.textContent = ` — ${bits.join(', ')}`;
      li.appendChild(span);
    }
    ul.appendChild(li);
  });
  return ul;
}

el.summarize.addEventListener('click', async () => {
  if (!openMeeting) return;
  el.summarize.disabled = true;
  const previous = el.summarize.textContent;
  el.summarize.textContent = 'Summarizing…';
  clearAlerts();
  try {
    const summary = await request('SUMMARIZE', { meetingId: openMeeting.id });
    openMeeting.summary = summary;
    openMeeting = await request('GET_MEETING', { meetingId: openMeeting.id });
    renderSummary();
    await refreshList();
  } catch (err) {
    alert_(String(err.message || err), true);
    el.summarize.textContent = previous;
  } finally {
    el.summarize.disabled = false;
  }
});

// ---------------------------------------------------------------- tabs

function selectTab(which) {
  const isTranscript = which === 'transcript';
  el.tabTranscript.classList.toggle('is-active', isTranscript);
  el.tabSummary.classList.toggle('is-active', !isTranscript);
  el.paneTranscript.hidden = !isTranscript;
  el.paneSummary.hidden = isTranscript;
}

el.tabTranscript.addEventListener('click', () => selectTab('transcript'));
el.tabSummary.addEventListener('click', () => selectTab('summary'));

// ------------------------------------------------------- copy / export

el.copy.addEventListener('click', async () => {
  if (!openMeeting) return;
  const text = openMeeting.summary
    ? summaryToMarkdown(openMeeting)
    : transcriptToMarkdown(openMeeting);
  try {
    await navigator.clipboard.writeText(text);
    el.copy.textContent = 'Copied';
    setTimeout(() => (el.copy.textContent = 'Copy'), 1200);
  } catch {
    alert_('Could not write to the clipboard.', true);
  }
});

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function slug(record) {
  const base = (record.title || 'meeting').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
  const date = new Date(record.startedAt).toISOString().slice(0, 10);
  return `${date}-${base}`.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

el.exportSummary.addEventListener('click', () => {
  if (!openMeeting) return;
  if (!openMeeting.summary) return alert_('Generate a summary first.', true);
  download(`${slug(openMeeting)}-summary.md`, summaryToMarkdown(openMeeting));
});

el.exportTranscript.addEventListener('click', () => {
  if (!openMeeting) return;
  if (!openMeeting.lines.length) return alert_('This meeting has no transcript.', true);
  download(`${slug(openMeeting)}-transcript.md`, transcriptToMarkdown(openMeeting));
});

// ---------------------------------------------------------------- utils

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

// ----------------------------------------------------------------- init

(async function init() {
  try {
    const state = await request('GET_STATE');
    recording = state.recording;
    activeMeetingId = state.meetingId;
    renderRecordBar();
    await refreshList();
    if (activeMeetingId) await showMeeting(activeMeetingId);
  } catch (err) {
    alert_(String(err.message || err), true);
  }
})();
