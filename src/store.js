/**
 * Meeting persistence on top of chrome.storage.local.
 *
 * Transcript lines are stored in fixed-size chunks, deliberately.
 *
 * The obvious design — one record holding a growing `lines` array — makes every
 * append a read-modify-write of the whole transcript, which is quadratic in the
 * length of the meeting. Measured against an in-memory stand-in, that was
 * 0.15 ms/line at 100 lines and 1.81 ms/line at 2000, with total time
 * quadrupling each time the line count doubled. Real chrome.storage.local hits
 * disk, so the true cost is higher, and it is paid in the service worker while
 * the meeting is running.
 *
 * Chunking makes an append touch only the newest chunk, so cost per line is
 * flat however long the meeting runs. Reading a whole transcript is still one
 * pass over every chunk, but that happens when a meeting is opened, not on
 * every recognized phrase.
 *
 * Keys:
 *   meetings          index of lightweight metadata
 *   meeting:<id>      metadata, summary, aliases, chat — never the lines
 *   meeting:<id>:c<n> one chunk of up to CHUNK_SIZE lines
 *
 * Only *final* recognition results are persisted. Interim results stream to the
 * panel for live display and are discarded.
 */

const INDEX_KEY = 'meetings';
const ACTIVE_KEY = 'activeMeeting';

/** Lines per chunk. Small enough that rewriting the newest chunk stays cheap. */
export const CHUNK_SIZE = 200;

const recordKey = (id) => `meeting:${id}`;
const chunkKey = (id, n) => `meeting:${id}:c${n}`;

async function get(key, fallback = null) {
  const out = await chrome.storage.local.get(key);
  return out[key] ?? fallback;
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/** Newest-first list of lightweight metadata. */
export async function listMeetings() {
  const index = await get(INDEX_KEY, []);
  return [...index].sort((a, b) => b.startedAt - a.startedAt);
}

/** Metadata only — cheap, and does not touch transcript chunks. */
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
    lineCount: 0,
    chunkCount: 0,
    summary: null,
    summaryMeta: null,
    /** raw speaker label -> display name, applied at read time */
    speakerAliases: {},
    /** follow-up Q&A history: [{ role, content, at }] */
    chat: [],
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
 * Append final transcript lines. Touches at most two chunk keys regardless of
 * how many lines the meeting already holds.
 */
export async function appendLines(id, lines) {
  if (!lines.length) return 0;
  const record = await getMeeting(id);
  if (!record) return 0;

  const startingChunks = record.chunkCount || 0;
  let index = Math.max(0, startingChunks - 1);
  let chunk = startingChunks === 0 ? [] : (await get(chunkKey(id, index), [])) || [];

  for (const line of lines) {
    if (chunk.length >= CHUNK_SIZE) {
      await set(chunkKey(id, index), chunk);
      index += 1;
      chunk = [];
    }
    chunk.push(line);
  }
  await set(chunkKey(id, index), chunk);

  record.chunkCount = index + 1;
  record.lineCount = (record.lineCount || 0) + lines.length;
  await set(recordKey(id), record);
  await updateIndex(id, { lineCount: record.lineCount });
  return record.lineCount;
}

/** Read every chunk of a meeting, in order. */
async function readChunks(id, record) {
  // Records written before chunking kept an inline array. Still readable so an
  // upgrade does not silently lose anyone's history.
  if (Array.isArray(record.lines)) return record.lines;

  const count = record.chunkCount || 0;
  if (!count) return [];
  const keys = Array.from({ length: count }, (_, n) => chunkKey(id, n));
  const stored = await chrome.storage.local.get(keys);
  return keys.flatMap((key) => stored[key] || []);
}

/** All lines for a meeting, with speaker aliases applied. */
export async function getLines(id) {
  const record = await getMeeting(id);
  if (!record) return [];
  return applyAliases(await readChunks(id, record), record.speakerAliases);
}

/** Metadata plus lines, for opening a meeting in the panel. */
export async function getMeetingWithLines(id) {
  const record = await getMeeting(id);
  if (!record) return null;
  return { ...record, lines: await getLines(id) };
}

function applyAliases(lines, aliases) {
  if (!aliases || !Object.keys(aliases).length) return lines;
  return lines.map((line) =>
    aliases[line.speaker] ? { ...line, speaker: aliases[line.speaker] } : line
  );
}

/**
 * Rename a speaker across a meeting. Stored as an alias rather than rewritten
 * into every chunk, so renaming is O(1) and reversible.
 */
export async function setSpeakerAlias(id, from, to) {
  const record = await getMeeting(id);
  if (!record) return null;
  const aliases = { ...(record.speakerAliases || {}) };
  const trimmed = (to || '').trim();
  if (!trimmed || trimmed === from) delete aliases[from];
  else aliases[from] = trimmed;
  record.speakerAliases = aliases;
  await set(recordKey(id), record);
  return aliases;
}

/** Distinct raw speaker labels in a meeting, for the rename UI. */
export async function listSpeakers(id) {
  const record = await getMeeting(id);
  if (!record) return [];
  const aliases = record.speakerAliases || {};
  const raw = new Set((await readChunks(id, record)).map((l) => l.speaker));
  return [...raw].map((label) => ({ label, alias: aliases[label] || null }));
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

export async function appendChat(id, entries) {
  const record = await getMeeting(id);
  if (!record) return [];
  record.chat = [...(record.chat || []), ...entries];
  await set(recordKey(id), record);
  return record.chat;
}

/** The in-progress meeting id, or null. Survives service-worker restarts. */
export async function getActiveMeetingId() {
  return get(ACTIVE_KEY);
}

export async function deleteMeeting(id) {
  const record = await getMeeting(id);
  const keys = [recordKey(id)];
  for (let n = 0; n < (record?.chunkCount || 0); n += 1) keys.push(chunkKey(id, n));
  await chrome.storage.local.remove(keys);
  const index = await get(INDEX_KEY, []);
  await set(
    INDEX_KEY,
    index.filter((m) => m.id !== id)
  );
}

/** Flatten lines into the plain text handed to the model. */
export function transcriptText(lines) {
  return (lines || []).map((l) => `${l.speaker}: ${l.text}`).join('\n');
}
