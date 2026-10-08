// "Get more voices" window: browse and download free Piper voices.
import { refreshPiperVoices, engines } from './voices.js';
import { script } from './script-ui.js';
import { t, uiLanguage, cleanError, UI_LANGUAGES, onLanguageChange } from './i18n.js';

const dialog = document.getElementById('library-dialog');
const openBtn = document.getElementById('library-btn');
const closeBtn = document.getElementById('library-close');
const listEl = document.getElementById('library-list');
const languageSelect = document.getElementById('library-language');
const regionSelect = document.getElementById('library-region');
const qualitySelect = document.getElementById('library-quality');

let catalog = null;
let catalogError = null;
const downloading = new Map(); // key -> progress text
const failures = new Map(); // key -> error from the last download attempt, shown on its row

// The app's own error codes, turned into messages people can act on.
function explainError(err) {
  const code = cleanError(err);
  if (code === 'PIPER_OFFLINE') return t('Couldn’t reach the Piper voice library. Check your internet connection.');
  if (code === 'DOWNLOAD_STALLED') return t('The download stopped responding. Check your internet connection and try again.');
  if (code === 'UNKNOWN_VOICE') return t('This voice isn’t in the library anymore.');
  const failed = code.match(/^DOWNLOAD_FAILED:(.*)$/);
  if (failed) return t('Download failed ({reason}). Try again later.', { reason: failed[1] });
  return code;
}

function installedKeys() {
  return new Set(engines.piper.voices.map((v) => v.key));
}

function message(text, isError = false) {
  listEl.innerHTML = '';
  const p = document.createElement('p');
  p.className = `library-empty${isError ? ' error' : ''}`;
  p.textContent = text;
  listEl.appendChild(p);
}

function fillLanguages() {
  const current = languageSelect.value || script.language;
  languageSelect.innerHTML = '';
  for (const [code, name] of Object.entries(UI_LANGUAGES)) languageSelect.add(new Option(name, code));
  languageSelect.value = current;
}

// Accents (countries) available for the chosen language, e.g. Spain and Mexico for Spanish.
function fillRegions() {
  const previous = regionSelect.value;
  regionSelect.innerHTML = '';
  regionSelect.add(new Option(t('All accents'), ''));
  const regions = new Map();
  for (const v of catalog ?? []) if (v.lang === languageSelect.value) regions.set(v.region, v.country || v.region);
  const named = [...regions].map(([code, country]) => [code, t(country)]);
  for (const [code, name] of named.sort((a, b) => a[1].localeCompare(b[1], uiLanguage()))) {
    regionSelect.add(new Option(name, code));
  }
  if ([...regionSelect.options].some((o) => o.value === previous)) regionSelect.value = previous;
}

function render() {
  if (catalogError) return message(explainError(catalogError), true);
  if (!catalog) return;
  const lang = languageSelect.value;
  const region = regionSelect.value;
  const goodOnly = qualitySelect.value === 'good';
  const voices = catalog.filter(
    (v) =>
      v.lang === lang &&
      (!region || v.region === region) &&
      (!goodOnly || v.quality === 'medium' || v.quality === 'high'),
  );
  if (!voices.length) return message(t('No voices match these filters.'));

  const installed = installedKeys();
  listEl.innerHTML = '';
  for (const v of voices) {
    const row = document.createElement('div');
    row.className = 'library-row';

    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = v.name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [t(v.country || v.region), t('{quality} quality', { quality: t(v.quality) })];
    if (v.numSpeakers > 1) parts.push(t('{n} speakers', { n: v.numSpeakers }));
    parts.push(`${v.sizeMB ?? '?'} MB`);
    meta.textContent = parts.join(' · ');
    info.append(title, meta);
    if (failures.has(v.key)) {
      const problem = document.createElement('div');
      problem.className = 'meta error';
      problem.textContent = failures.get(v.key);
      info.appendChild(problem);
    }
    row.appendChild(info);

    const btn = document.createElement('button');
    if (downloading.has(v.key)) {
      btn.textContent = downloading.get(v.key);
      btn.disabled = true;
    } else if (installed.has(v.key)) {
      const mark = document.createElement('span');
      mark.className = 'installed';
      mark.textContent = t('✓ Installed');
      row.appendChild(mark);
      btn.textContent = t('Remove');
      btn.addEventListener('click', () => remove(v.key));
    } else {
      btn.textContent = t('Download');
      btn.addEventListener('click', () => download(v.key));
    }
    row.appendChild(btn);
    listEl.appendChild(row);
  }
}

async function download(key) {
  failures.delete(key);
  downloading.set(key, t('Starting…'));
  render();
  try {
    await window.piperVoices.download(key);
    await refreshPiperVoices();
  } catch (err) {
    failures.set(key, t('Couldn’t download this voice: {message}', { message: explainError(err) }));
  } finally {
    downloading.delete(key);
    render();
  }
}

async function remove(key) {
  try {
    await window.piperVoices.remove(key);
  } catch (err) {
    failures.set(key, explainError(err));
  }
  await refreshPiperVoices();
  render();
}

window.piperVoices?.onProgress(({ key, received, total }) => {
  if (!downloading.has(key)) return;
  downloading.set(key, total > 0 ? `${Math.min(100, Math.floor((received / total) * 100))}%` : t('Downloading…'));
  render();
});

openBtn.addEventListener('click', async () => {
  // Start with voices for the script's language.
  languageSelect.value = '';
  fillLanguages();
  dialog.showModal();
  if (catalog) {
    fillRegions();
    return render();
  }
  catalogError = null;
  message(t('Loading the voice list…'));
  try {
    catalog = await window.piperVoices.catalog();
    catalogError = null;
  } catch (err) {
    catalogError = err;
  }
  fillRegions();
  render();
});
closeBtn.addEventListener('click', () => dialog.close());
languageSelect.addEventListener('change', () => {
  regionSelect.value = '';
  fillRegions();
  render();
});
regionSelect.addEventListener('change', render);
qualitySelect.addEventListener('change', render);
onLanguageChange(() => {
  if (!dialog.open) return;
  fillRegions();
  render();
});
