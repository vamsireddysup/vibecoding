/**
 * Reads participant names, and who is currently speaking, from the meeting page.
 *
 * Two signals with very different reliability, deliberately separated:
 *
 *   Participant names come from tiles and roster entries. Reasonably stable,
 *   and useful on their own — the panel offers them when renaming a speaker, so
 *   the user picks a real name from a list instead of typing it.
 *
 *   Active speaker comes from whatever each platform uses to highlight the
 *   person talking. This is genuinely fragile: it depends on class names and
 *   attributes that change whenever a platform reskins, and it cannot be
 *   verified without running against the live product.
 *
 * The split matters because it decides the failure mode. If active-speaker
 * detection breaks, transcripts keep the generic "Others" label and the manual
 * rename still works — nothing is lost that the extension had before. Nothing
 * here ever guesses: no name is reported unless the page actually says so.
 */

const POLL_MS = 700;

/**
 * Per-platform selectors, kept in one table so fixing a platform is a one-line
 * change rather than an archaeology exercise.
 */
const PLATFORMS = [
  {
    match: /(^|\.)meet\.google\.com$/,
    name: 'Google Meet',
    tiles: '[data-participant-id], [data-requested-participant-id]',
    nameFrom: (tile) =>
      tile.getAttribute('data-self-name') ||
      text(tile.querySelector('[data-self-name]')) ||
      text(tile.querySelector('[jsname]')),
  },
  {
    match: /(^|\.)zoom\.us$/,
    name: 'Zoom',
    tiles: '[class*="participant"], [class*="speaker-view"] [class*="video-avatar"]',
    nameFrom: (tile) =>
      tile.getAttribute('aria-label') || text(tile.querySelector('[class*="participant-name"]')),
  },
  {
    match: /(^|\.)teams\.(microsoft|live)\.com$/,
    name: 'Microsoft Teams',
    tiles: '[data-tid*="participant"], [data-cid="calling-participant-stream"]',
    nameFrom: (tile) =>
      tile.getAttribute('data-tid-displayname') ||
      tile.getAttribute('aria-label') ||
      text(tile.querySelector('[data-tid="participant-name"]')),
  },
];

const platform = PLATFORMS.find((p) => p.match.test(location.hostname));
if (platform) start(platform);

function start(config) {
  let lastSpeaker = null;
  let lastRosterKey = '';

  setInterval(() => {
    const tiles = [...document.querySelectorAll(config.tiles)];
    if (!tiles.length) return;

    const roster = [];
    let speaking = null;

    for (const tile of tiles) {
      const name = cleanName(config.nameFrom(tile));
      if (!name) continue;
      if (!roster.includes(name)) roster.push(name);
      if (!speaking && isSpeaking(tile)) speaking = name;
    }

    const rosterKey = roster.join('|');
    if (rosterKey && rosterKey !== lastRosterKey) {
      lastRosterKey = rosterKey;
      send({ type: 'PARTICIPANTS', names: roster });
    }

    // Report only transitions. Re-sending the same name every tick would fill
    // the service worker's buffer with noise and keep it awake for nothing.
    if (speaking && speaking !== lastSpeaker) {
      lastSpeaker = speaking;
      send({ type: 'ACTIVE_SPEAKER', name: speaking, at: Date.now() });
    } else if (!speaking) {
      lastSpeaker = null;
    }
  }, POLL_MS);
}

/**
 * Best-effort "is this tile the one talking".
 *
 * Matches on intent rather than exact class names — platforms rename classes
 * constantly, but the words they choose for this concept ("speaking", "active",
 * "talking") are far more durable, and ARIA attributes more durable still.
 */
function isSpeaking(tile) {
  if (tile.getAttribute('aria-pressed') === 'true') return true;
  if (/speaking|talking/i.test(tile.getAttribute('aria-label') || '')) return true;
  if (tile.matches('[data-is-speaking="true"], [data-speaking="true"]')) return true;

  const className = typeof tile.className === 'string' ? tile.className : '';
  if (/\b(is-)?(speaking|active-speaker|talking)\b/i.test(className)) return true;

  return Boolean(
    tile.querySelector(
      '[data-is-speaking="true"], [data-speaking="true"], [class*="speaking"], [class*="active-speaker"]'
    )
  );
}

const text = (el) => (el?.textContent || '').trim();

/**
 * Reject anything that is not plausibly a person's name. Attribute values on
 * these pages are full of UI strings, and a speaker label reading
 * "Mute microphone" is worse than one reading "Others".
 */
function cleanName(raw) {
  const name = (raw || '').replace(/\s+/g, ' ').trim().replace(/\s*\((you|host|presenter)\)$/i, '');
  if (!name || name.length > 60) return null;
  if (/^(you|unknown|guest)$/i.test(name)) return null;
  if (/(mute|unmute|camera|microphone|pin |present|screen|more options|raise hand)/i.test(name)) {
    return null;
  }
  if (!/\p{L}/u.test(name)) return null;
  return name;
}

function send(payload) {
  // The service worker may be asleep; a dropped observation is not worth an error.
  chrome.runtime.sendMessage({ target: 'sw', ...payload }).catch(() => {});
}
