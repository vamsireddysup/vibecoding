import { ANTHROPIC_MODELS, getSettings, saveSettings } from '../config.js';
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

function selectedProvider() {
  return document.querySelector('input[name="provider"]:checked')?.value || 'anthropic';
}

function syncProviderVisibility() {
  const provider = selectedProvider();
  $('fs-anthropic').hidden = provider !== 'anthropic';
  $('fs-openai').hidden = provider !== 'openai';
}

async function load() {
  fillSelect($('anthropic-model'), ANTHROPIC_MODELS.map((m) => [m.id, m.label]));
  fillSelect($('language'), LANGUAGES);

  const settings = await getSettings();

  document
    .querySelectorAll('input[name="provider"]')
    .forEach((radio) => (radio.checked = radio.value === settings.provider));

  $('anthropic-key').value = settings.anthropicKey;
  $('anthropic-model').value = settings.anthropicModel;
  $('openai-key').value = settings.openaiKey;
  $('openai-model').value = settings.openaiModel;
  $('capture-tab').checked = settings.captureTab;
  $('capture-mic').checked = settings.captureMic;

  // A previously saved language may not be in the list if it was set by an
  // older version; fall back rather than showing a blank select.
  const known = LANGUAGES.some(([code]) => code === settings.language);
  $('language').value = known ? settings.language : 'en-US';

  syncProviderVisibility();
}

document
  .querySelectorAll('input[name="provider"]')
  .forEach((radio) => radio.addEventListener('change', syncProviderVisibility));

$('save').addEventListener('click', async () => {
  const captureTab = $('capture-tab').checked;
  const captureMic = $('capture-mic').checked;
  const saved = $('saved');

  if (!captureTab && !captureMic) {
    saved.textContent = 'Enable at least one audio source.';
    saved.className = 'saved result-bad';
    return;
  }

  await saveSettings({
    provider: selectedProvider(),
    anthropicKey: $('anthropic-key').value.trim(),
    anthropicModel: $('anthropic-model').value,
    openaiKey: $('openai-key').value.trim(),
    openaiModel: $('openai-model').value.trim(),
    language: $('language').value,
    captureTab,
    captureMic,
  });

  saved.textContent = 'Saved';
  saved.className = 'saved';
  setTimeout(() => (saved.textContent = ''), 1600);
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

  result.textContent = ok
    ? `On-device recognition is ready for ${language}.`
    : message;
  result.className = ok ? 'note result-ok' : 'note result-bad';
});

load();
