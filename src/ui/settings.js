import {
  ANTHROPIC_MODELS,
  BASE_URL_PRESETS,
  OPENAI_DEFAULT_BASE_URL,
  SUMMARY_STYLES,
  getSettings,
  isLocalEndpoint,
  saveSettings,
} from '../config.js';
import { ensureOnDeviceReady, isSupported } from '../capture/chrome-speech.js';

// Chrome's on-device speech packs cover a limited set of languages; this is the
// commonly available subset. If one is missing on a machine, "Check on-device
// support" reports it rather than failing silently at meeting time.
const LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-IN', 'English (India)'],
  ['en-AU', 'English (Australia)'],
  ['es-ES', 'Spanish (Spain)'],
  ['es-US', 'Spanish (US)'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['it-IT', 'Italian'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['nl-NL', 'Dutch'],
  ['hi-IN', 'Hindi'],
  ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'],
  ['cmn-Hans-CN', 'Mandarin (Simplified)'],
  ['ru-RU', 'Russian'],
  ['pl-PL', 'Polish'],
];

const $ = (id) => document.getElementById(id);

function fillSelect(select, entries) {
  select.replaceChildren();
  for (const [value, label] of entries) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
}

const selectedProvider = () =>
  document.querySelector('input[name="provider"]:checked')?.value || 'anthropic';

function syncVisibility() {
  const provider = selectedProvider();
  $('fs-anthropic').hidden = provider !== 'anthropic';
  $('fs-openai').hidden = provider !== 'openai';
  $('key-optional').hidden = !isLocalEndpoint($('openai-base-url').value);
  $('custom-prompt-wrap').hidden = $('summary-style').value !== 'custom';
}

function renderPresets() {
  const wrap = $('presets');
  wrap.replaceChildren();
  for (const preset of BASE_URL_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = preset.label;
    button.title = preset.url;
    button.addEventListener('click', () => {
      $('openai-base-url').value = preset.url;
      syncVisibility();
    });
    wrap.appendChild(button);
  }
}

async function load() {
  fillSelect(
    $('anthropic-model'),
    ANTHROPIC_MODELS.map((m) => [m.id, m.label])
  );
  fillSelect($('language'), LANGUAGES);
  fillSelect(
    $('summary-style'),
    SUMMARY_STYLES.map((s) => [s.id, s.label])
  );
  renderPresets();

  const settings = await getSettings();

  document
    .querySelectorAll('input[name="provider"]')
    .forEach((radio) => {
      radio.checked = radio.value === settings.provider;
    });

  $('anthropic-key').value = settings.anthropicKey;
  $('anthropic-model').value = settings.anthropicModel;
  $('openai-key').value = settings.openaiKey;
  $('openai-model').value = settings.openaiModel;
  $('openai-base-url').value = settings.openaiBaseUrl || OPENAI_DEFAULT_BASE_URL;
  $('summary-style').value = settings.summaryStyle;
  $('custom-prompt').value = settings.customPrompt;
  $('capture-tab').checked = settings.captureTab;
  $('capture-mic').checked = settings.captureMic;
  $('auto-start').checked = settings.autoStart;
  $('show-cost').checked = settings.showCostEstimate;

  // A saved language may not be in the list if an older version set it; fall
  // back rather than showing a blank select.
  const known = LANGUAGES.some(([code]) => code === settings.language);
  $('language').value = known ? settings.language : 'en-US';

  syncVisibility();
}

document
  .querySelectorAll('input[name="provider"]')
  .forEach((radio) => radio.addEventListener('change', syncVisibility));
$('summary-style').addEventListener('change', syncVisibility);
$('openai-base-url').addEventListener('input', syncVisibility);

/**
 * A custom endpoint needs host permission, which MV3 cannot declare statically
 * for an arbitrary URL. Ask for it at save time, when the user has just typed
 * the host and the prompt makes sense, rather than at first use mid-meeting.
 */
async function ensureHostPermission(baseUrl) {
  if (!baseUrl || baseUrl === OPENAI_DEFAULT_BASE_URL) return true;
  let origin;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

$('save').addEventListener('click', async () => {
  const saved = $('saved');
  const fail = (message) => {
    saved.textContent = message;
    saved.className = 'saved result-bad';
  };

  const captureTab = $('capture-tab').checked;
  const captureMic = $('capture-mic').checked;
  if (!captureTab && !captureMic) return fail('Enable at least one audio source.');

  const baseUrl = $('openai-base-url').value.trim() || OPENAI_DEFAULT_BASE_URL;
  if (selectedProvider() === 'openai') {
    try {
      new URL(baseUrl);
    } catch {
      return fail('That base URL is not a valid URL.');
    }
    if (!(await ensureHostPermission(baseUrl))) {
      return fail('Permission for that host was declined, so calls to it would fail.');
    }
  }

  await saveSettings({
    provider: selectedProvider(),
    anthropicKey: $('anthropic-key').value.trim(),
    anthropicModel: $('anthropic-model').value,
    openaiKey: $('openai-key').value.trim(),
    openaiModel: $('openai-model').value.trim(),
    openaiBaseUrl: baseUrl.replace(/\/+$/, ''),
    summaryStyle: $('summary-style').value,
    customPrompt: $('custom-prompt').value.trim(),
    language: $('language').value,
    captureTab,
    captureMic,
    autoStart: $('auto-start').checked,
    showCostEstimate: $('show-cost').checked,
  });

  saved.textContent = 'Saved';
  saved.className = 'saved';
  setTimeout(() => {
    saved.textContent = '';
  }, 1600);
  return undefined;
});

$('check').addEventListener('click', async () => {
  const result = $('check-result');
  result.textContent = 'Checking…';
  result.className = 'note';

  if (!isSupported()) {
    result.textContent =
      'This version of Chrome has no Web Speech API. Update to Chrome 139 or later.';
    result.className = 'note result-bad';
    return;
  }

  const language = $('language').value;
  const { ok, status, message } = await ensureOnDeviceReady(language);

  if (ok && status === 'unknown') {
    result.textContent =
      `This Chrome build does not expose the availability check, so support for ${language} ` +
      'cannot be confirmed in advance. Recording will report an error if it is missing.';
    result.className = 'note';
    return;
  }

  result.textContent = ok ? `On-device recognition is ready for ${language}.` : message;
  result.className = ok ? 'note result-ok' : 'note result-bad';
});

load();
