/**
 * Meeting persistence on top of chrome.storage.local.
 *
 * Records are split across keys rather than held in one blob: an index of
 * lightweight metadata plus one key per meeting. That keeps listing past
 * meetings cheap and stops a long transcript from being rewritten on every read.
 *
 * Only *final* recognition results are persisted. Interim results are streamed
 * to the panel for live display and then discarded — persisting them would mean
 * a storage write on every syllable.
 */

const INDEX_KEY = 'meetings';
const ACTIVE_KEY = 'activeMeeting';
const recordKey = (id) => `meeting:${id}`;

async function get(key, fallback = null) {
  const out = await chrome.storage.local.get(key);
  return out[key] ?? fallback;
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/** Newest-first list of `{ id, title, url, startedAt, endedAt, lineCount, hasSummary }`. */
export async function listMeetings() {
  const index = await get(INDEX_KEY, []);
  return [...index].sort((a, b) => b.startedAt - a.startedAt);
}

export async function getMeeting(id) {
  return get(recordKey(id));
}

async function updateIndex(id, patch) {
  const index = await get(INDEX_KEY, []);
  const at = index.findIndex((m) => m.id === id);
  if (at === -1) index.push({ id, ...patch });
  else index[at] = { ...index[at], ...patch };
  await set(INDEX_KEY, index);
}

export async function createMeeting({ title, url }) {
  const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    title: title || 'Untitled meeting',
    url: url || '',
    startedAt: Date.now(),
    endedAt: null,
    lines: [],
    summary: null,
    summaryMeta: null,
  };
  await set(recordKey(id), record);
  await updateIndex(id, {
    title: record.title,
    url: record.url,
    startedAt: record.startedAt,
    endedAt: null,
    lineCount: 0,
    hasSummary: false,
  });
  await set(ACTIVE_KEY, id);
  return record;
}

/**
 * Append final transcript lines. Returns the updated line count.
 *
 * Read-modify-write is safe here because every caller is the single service
 * worker, and appends are serialized behind one await chain.
 */
export async function appendLines(id, lines) {
  if (!lines.length) return 0;
  const record = await getMeeting(id);
  if (!record) return 0;
  record.lines.push(...lines);
  await set(recordKey(id), record);
  await updateIndex(id, { lineCount: record.lines.length });
  return record.lines.length;
}

export async function endMeeting(id) {
  const record = await getMeeting(id);
  if (record && !record.endedAt) {
    record.endedAt = Date.now();
    await set(recordKey(id), record);
    await updateIndex(id, { endedAt: record.endedAt });
  }
  await chrome.storage.local.remove(ACTIVE_KEY);
  return record;
}

export async function saveSummary(id, summary, meta) {
  const record = await getMeeting(id);
  if (!record) return null;
  record.summary = summary;
  record.summaryMeta = { ...meta, at: Date.now() };
  await set(recordKey(id), record);
  await updateIndex(id, { hasSummary: true });
  return record;
}

/** The in-progress meeting id, or null. Survives service-worker restarts. */
export async function getActiveMeetingId() {
  return get(ACTIVE_KEY);
}

export async function deleteMeeting(id) {
  await chrome.storage.local.remove(recordKey(id));
  const index = await get(INDEX_KEY, []);
  await set(INDEX_KEY, index.filter((m) => m.id !== id));
}

/** Flatten a record's lines into the plain text handed to the model. */
export function transcriptText(record) {
  return record.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
}
