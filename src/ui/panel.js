/**
 * Side panel UI.
 *
 * All state lives in the service worker; this file asks for it and renders it.
 * Transcript text is always inserted with textContent — it comes from speech
 * recognition of arbitrary audio and must never be parsed as HTML.
 */

import { formatEstimate, summaryToMarkdown, transcriptToMarkdown } from '../providers/provider.js';

const $ = (id) => document.getElementById(id);

const el = {
  record: $('record'),
  status: $('status'),
  detected: $('detected'),
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
  tabAsk: $('tab-ask'),
  paneTranscript: $('pane-transcript'),
  paneSummary: $('pane-summary'),
  paneAsk: $('pane-ask'),

  speakers: $('speakers'),
  transcript: $('transcript'),
  transcriptEmpty: $('transcript-empty'),
  jumpLatest: $('jump-latest'),

  summarize: $('summarize'),
  summaryHint: $('summary-hint'),
  summary: $('summary'),

  chat: $('chat'),
  askForm: $('ask-form'),
  question: $('question'),
  ask: $('ask'),
  askHint: $('ask-hint'),

  copy: $('copy'),
  exportSummary: $('export-summary'),
  exportTranscript: $('export-transcript'),
  del: $('delete'),
};

let recording = false;
let activeMeetingId = null;
let openMeeting = null;
let interimEls = {};
/** The user has scrolled up to read; do not yank them back to the bottom. */
let stickToBottom = true;

// ------------------------------------------------------------ messaging

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'panel-request', type, ...payload });
  if (!response) throw new Error('The extension background did not respond. Try reopening the panel.');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'panel') return;

  switch (message.type) {
    case 'LINE':
      if (openMeeting && openMeeting.id === activeMeetingId) appendLine(message.line);
      break;
    case 'STATE':
      recording = message.recording;
      activeMeetingId = message.meetingId;
      (message.warnings || []).forEach((w) => alert_(w, false));
      renderRecordBar();
      break;
    case 'SUMMARY_DELTA':
      if (openMeeting?.id === message.meetingId) renderSummaryBody(message.text, true);
      break;
    case 'ANSWER_DELTA':
      if (openMeeting?.id === message.meetingId) renderStreamingAnswer(message.text);
      break;
    case 'WARNING':
      alert_(message.message, message.fatal);
      break;
    default:
      break;
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

const clearAlerts = () => el.alerts.replaceChildren();

// -------------------------------------------------------------- record

function renderRecordBar() {
  el.record.textContent = recording ? 'Stop recording' : 'Start recording';
  el.record.classList.toggle('is-recording', recording);
  el.status.textContent = recording ? 'Recording' : 'Idle';
  el.status.classList.toggle('is-live', recording);
}

function renderDetected(detectedMeeting) {
  const show = Boolean(detectedMeeting) && !recording;
  el.detected.hidden = !show;
  if (show) el.detected.textContent = `${detectedMeeting} detected in this tab — ready to record.`;
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
    el.detected.hidden = recording;
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
  renderSpeakers();
  renderSummary();
  renderChat();
  selectTab('transcript');
  return undefined;
}

el.back.addEventListener('click', showList);

el.del.addEventListener('click', async () => {
  if (!openMeeting) return;
  if (openMeeting.id === activeMeetingId) {
    alert_('Stop the recording before deleting this meeting.', true);
    return;
  }
  await request('DELETE_MEETING', { meetingId: openMeeting.id });
  showList();
});

// ----------------------------------------------------------- transcript

/**
 * Render in batches rather than all at once. A long meeting is thousands of
 * lines, and building them in one synchronous pass locks the panel for as long
 * as it takes; yielding between batches keeps it responsive while it fills in.
 */
const RENDER_BATCH = 150;

function renderTranscript() {
  el.transcript.replaceChildren();
  interimEls = {};
  stickToBottom = true;

  const lines = openMeeting.lines || [];
  el.transcriptEmpty.hidden = lines.length > 0;

  let index = 0;
  const step = () => {
    const fragment = document.createDocumentFragment();
    for (let n = 0; n < RENDER_BATCH && index < lines.length; n += 1, index += 1) {
      fragment.appendChild(lineNode(lines[index]));
    }
    el.transcript.appendChild(fragment);
    if (index < lines.length) requestAnimationFrame(step);
    else scrollToBottom();
  };
  step();
}

function lineNode(line) {
  const row = document.createElement('div');
  const known = line.speaker === 'You';
  row.className = `line ${known ? 'you' : 'others'}${line.interim ? ' interim' : ''}`;

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
 * `track` controls whether a final line joins the in-memory record. Live lines
 * from the service worker need it, so Copy and Export see them without a round
 * trip; lines replayed during a re-render must not, or the transcript doubles.
 */
function appendLine(line, { track = true } = {}) {
  const existing = interimEls[line.speaker];
  if (existing) {
    existing.remove();
    delete interimEls[line.speaker];
  }

  const node = lineNode(line);
  el.transcript.appendChild(node);

  if (line.interim) interimEls[line.speaker] = node;
  else if (track && openMeeting) openMeeting.lines.push(line);

  el.transcriptEmpty.hidden = true;
  if (stickToBottom) scrollToBottom();
  else el.jumpLatest.hidden = false;
}

function scrollToBottom() {
  el.transcript.lastElementChild?.scrollIntoView({ block: 'end' });
  el.jumpLatest.hidden = true;
}

// Once the user scrolls up they are reading; new lines must not drag them away.
document.addEventListener(
  'scroll',
  () => {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 60;
    stickToBottom = nearBottom;
    if (nearBottom) el.jumpLatest.hidden = true;
  },
  { passive: true }
);

el.jumpLatest.addEventListener('click', () => {
  stickToBottom = true;
  scrollToBottom();
});

// ------------------------------------------------------------- speakers

async function renderSpeakers() {
  const { speakers, suggestions } = await request('LIST_SPEAKERS', { meetingId: openMeeting.id });
  el.speakers.replaceChildren();

  const renameable = speakers.filter((s) => s.label !== 'You');
  el.speakers.hidden = renameable.length === 0;
  if (!renameable.length) return;

  const label = document.createElement('span');
  label.className = 'speakers-label';
  label.textContent = 'Speakers:';
  el.speakers.appendChild(label);

  for (const speaker of renameable) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = speaker.alias || speaker.label;
    chip.title = `Rename "${speaker.label}"`;
    chip.addEventListener('click', () => renameSpeaker(speaker, suggestions));
    el.speakers.appendChild(chip);
  }
}

async function renameSpeaker(speaker, suggestions) {
  const hint = suggestions?.length
    ? `\n\nSeen in this meeting: ${suggestions.join(', ')}`
    : '';
  // eslint-disable-next-line no-alert
  const next = window.prompt(`Rename "${speaker.label}" to:${hint}`, speaker.alias || '');
  if (next === null) return;
  await request('RENAME_SPEAKER', { meetingId: openMeeting.id, from: speaker.label, to: next });
  await showMeeting(openMeeting.id);
}

// -------------------------------------------------------------- summary

function renderSummary() {
  const s = openMeeting.summary;
  el.summarize.textContent = s ? 'Regenerate summary' : 'Summarize with AI';
  el.summarize.disabled = (openMeeting.lines || []).length === 0;
  renderSummaryBody(s, false);
  updateEstimate();
}

async function updateEstimate() {
  if (!openMeeting?.lines?.length) {
    el.summaryHint.textContent = 'Record something first — there is no transcript to summarize yet.';
    return;
  }
  el.summaryHint.textContent = 'Uses your own API key. Nothing is sent until you press the button.';
  try {
    const estimate = await request('ESTIMATE', { meetingId: openMeeting.id });
    const text = formatEstimate(estimate);
    if (text) {
      el.summaryHint.textContent = `${text}. ${estimate.note || ''}`.trim();
    }
  } catch {
    // An estimate is a courtesy; never block summarizing because it failed.
  }
}

/** `streaming` renders a partial value; otherwise this is the saved summary. */
function renderSummaryBody(s, streaming) {
  el.summary.replaceChildren();
  if (!s) return;

  if (streaming) el.summary.classList.add('is-streaming');
  else el.summary.classList.remove('is-streaming');

  if (s.tldr) el.summary.append(heading('Summary'), paragraph(s.tldr));
  if (s.keyPoints?.length) el.summary.append(heading('Key points'), bulletList(s.keyPoints));
  if (s.decisions?.length) el.summary.append(heading('Decisions'), bulletList(s.decisions));
  if (s.actionItems?.length) el.summary.append(heading('Action items'), actionList(s.actionItems));

  if (!streaming && !s.decisions?.length && !s.actionItems?.length) {
    el.summary.append(paragraph('No decisions or action items were recorded in this meeting.'));
  }
}

el.summarize.addEventListener('click', async () => {
  if (!openMeeting) return;
  el.summarize.disabled = true;
  const previous = el.summarize.textContent;
  el.summarize.textContent = 'Summarizing…';
  clearAlerts();
  try {
    await request('SUMMARIZE', { meetingId: openMeeting.id });
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

// ------------------------------------------------------------------ ask

function renderChat() {
  el.chat.replaceChildren();
  for (const turn of openMeeting.chat || []) el.chat.appendChild(chatNode(turn));
  el.askHint.textContent = (openMeeting.lines || []).length
    ? 'Answers come from this transcript only.'
    : 'Record something first — there is nothing to ask about yet.';
  el.ask.disabled = (openMeeting.lines || []).length === 0;
}

function chatNode({ role, content }) {
  const row = document.createElement('div');
  row.className = `turn ${role}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = role === 'user' ? 'You' : 'AI';
  const body = document.createElement('span');
  body.className = 'what';
  body.textContent = content;
  row.append(who, body);
  return row;
}

let streamingAnswerNode = null;

function renderStreamingAnswer(text) {
  if (!streamingAnswerNode) {
    streamingAnswerNode = chatNode({ role: 'assistant', content: '' });
    el.chat.appendChild(streamingAnswerNode);
  }
  streamingAnswerNode.querySelector('.what').textContent = text;
  streamingAnswerNode.scrollIntoView({ block: 'end' });
}

el.askForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = el.question.value.trim();
  if (!question || !openMeeting) return;

  el.chat.appendChild(chatNode({ role: 'user', content: question }));
  el.question.value = '';
  el.ask.disabled = true;
  streamingAnswerNode = null;
  clearAlerts();

  try {
    await request('ASK', { meetingId: openMeeting.id, question });
    openMeeting = await request('GET_MEETING', { meetingId: openMeeting.id });
    streamingAnswerNode = null;
    renderChat();
  } catch (err) {
    alert_(String(err.message || err), true);
  } finally {
    el.ask.disabled = false;
  }
});

// ---------------------------------------------------------------- tabs

function selectTab(which) {
  const panes = { transcript: el.paneTranscript, summary: el.paneSummary, ask: el.paneAsk };
  const tabs = { transcript: el.tabTranscript, summary: el.tabSummary, ask: el.tabAsk };
  for (const [name, pane] of Object.entries(panes)) {
    pane.hidden = name !== which;
    tabs[name].classList.toggle('is-active', name === which);
  }
}

el.tabTranscript.addEventListener('click', () => selectTab('transcript'));
el.tabSummary.addEventListener('click', () => selectTab('summary'));
el.tabAsk.addEventListener('click', () => selectTab('ask'));

// ------------------------------------------------------- copy / export

el.copy.addEventListener('click', async () => {
  if (!openMeeting) return;
  const text = openMeeting.summary
    ? summaryToMarkdown(openMeeting)
    : transcriptToMarkdown(openMeeting);
  try {
    await navigator.clipboard.writeText(text);
    el.copy.textContent = 'Copied';
    setTimeout(() => {
      el.copy.textContent = 'Copy';
    }, 1200);
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
  if (!openMeeting.summary) {
    alert_('Generate a summary first.', true);
    return;
  }
  download(`${slug(openMeeting)}-summary.md`, summaryToMarkdown(openMeeting));
});

el.exportTranscript.addEventListener('click', () => {
  if (!openMeeting) return;
  if (!openMeeting.lines?.length) {
    alert_('This meeting has no transcript.', true);
    return;
  }
  download(`${slug(openMeeting)}-transcript.md`, transcriptToMarkdown(openMeeting));
});

// --------------------------------------------------------------- utils

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
    const bits = [item.owner && `owner: ${item.owner}`, item.due && `due: ${item.due}`].filter(Boolean);
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
    renderDetected(state.detectedMeeting);
    await refreshList();
    if (activeMeetingId) await showMeeting(activeMeetingId);
  } catch (err) {
    alert_(String(err.message || err), true);
  }
})();
