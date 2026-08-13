/**
 * User settings, stored in chrome.storage.local.
 *
 * The API key is stored unencrypted. Chrome offers extensions no real secret
 * store, so this is the same posture every bring-your-own-key extension has;
 * the README says so plainly rather than implying otherwise.
 */

const KEY = 'settings';

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — best quality' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — balanced' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — cheapest' },
];

export const DEFAULTS = {
  provider: 'anthropic',
  anthropicKey: '',
  openaiKey: '',
  anthropicModel: 'claude-opus-5',
  // Free text rather than a dropdown: OpenAI's lineup changes often, and a
  // hardcoded list goes stale and breaks the extension for no good reason.
  // A wrong value surfaces as a readable 404 from the API.
  openaiModel: 'gpt-5',
  language: 'en-US',
  captureMic: true,
  captureTab: true,
};

export async function getSettings() {
  const out = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(out[KEY] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** The key and model for the currently selected provider. */
export function activeCredentials(settings) {
  return settings.provider === 'openai'
    ? { provider: 'openai', apiKey: settings.openaiKey, model: settings.openaiModel }
    : { provider: 'anthropic', apiKey: settings.anthropicKey, model: settings.anthropicModel };
}
