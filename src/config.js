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

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Endpoints people actually point this at. Offered as one-click presets in
 * Settings; the field stays free text because this list will go stale.
 */
export const BASE_URL_PRESETS = [
  { label: 'OpenAI', url: OPENAI_DEFAULT_BASE_URL, keyless: false },
  { label: 'Ollama (local)', url: 'http://localhost:11434/v1', keyless: true },
  { label: 'LM Studio (local)', url: 'http://localhost:1234/v1', keyless: true },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', keyless: false },
];

export const SUMMARY_STYLES = [
  { id: 'notes', label: 'Full notes — everything of substance' },
  { id: 'exec', label: 'Executive summary — short and high level' },
  { id: 'decisions', label: 'Decisions and actions only' },
  { id: 'custom', label: 'Custom prompt' },
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
  // Any OpenAI-compatible endpoint: Ollama, LM Studio, OpenRouter, Azure, or a
  // self-hosted gateway. Local endpoints mean a meeting never leaves the machine.
  openaiBaseUrl: OPENAI_DEFAULT_BASE_URL,
  language: 'en-US',
  captureMic: true,
  captureTab: true,
  summaryStyle: 'notes',
  customPrompt: '',
  // Off by default. Silently starting to record people is the wrong default for
  // a tool whose entire job is recording people.
  autoStart: false,
  showCostEstimate: true,
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

/** True for endpoints that are local and therefore normally unauthenticated. */
export function isLocalEndpoint(url = '') {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

/** The key, model and endpoint for the currently selected provider. */
export function activeCredentials(settings) {
  if (settings.provider === 'openai') {
    const baseUrl = (settings.openaiBaseUrl || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    return {
      provider: 'openai',
      apiKey: settings.openaiKey,
      model: settings.openaiModel,
      baseUrl,
      // Ollama and LM Studio need no key; requiring one would block the most
      // privacy-preserving way to run this.
      allowKeyless: isLocalEndpoint(baseUrl),
    };
  }
  return {
    provider: 'anthropic',
    apiKey: settings.anthropicKey,
    model: settings.anthropicModel,
    allowKeyless: false,
  };
}
