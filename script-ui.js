import * as pdfjs from './vendor/pdf.min.mjs';
import {
  extractPdfLines,
  parsePositionedLines,
  parseParagraphs,
  linesToParagraphs,
  listCharacters,
  guessUserCharacter,
  detectLanguage,
  guessGenders,
} from './script-parser.js';
import {
  engines,
  initVoices,
  onVoicesChange,
  voiceGroups,
  defaultVoice,
  getLineAudio,
  playBuffer,
  stopPlayback,
  voiceLanguage,
  VoiceError,
} from './voices.js';
import { t, tFor, setText, setErrorText, AppError, UI_LANGUAGES, onLanguageChange, applyTranslations } from './i18n.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const ACTION = '__action';

const importBtn = document.getElementById('import-btn');
const fileInput = document.getElementById('file-input');
const fileNameEl = document.getElementById('file-name');
const roleLabel = document.getElementById('role-label');
const roleSelect = document.getElementById('role-select');
const addCharacterForm = document.getElementById('add-character');
const newCharacterInput = document.getElementById('new-character');
const statsEl = document.getElementById('script-stats');
const emptyEl = document.getElementById('script-empty');
const helpEl = document.getElementById('script-help');
const bodyEl = document.getElementById('script-body');
const voicesPanel = document.getElementById('voices-panel');
const engineStatusEl = document.getElementById('engine-status');
const voiceRowsEl = document.getElementById('voice-rows');
const prepareBtn = document.getElementById('prepare-btn');
const prepareStatusEl = document.getElementById('prepare-status');
const languageLabel = document.getElementById('language-label');
const languageSelect = document.getElementById('script-language');

// The imported script, shared with later stages (voices, rehearsal).
// `language` is the script's language ('en' | 'es' | 'pt'); it decides which voices are offered.
export const script = {
  fileName: '',
  elements: [],
  extraCharacters: [],
  userCharacter: null,
  voices: {},
  language: 'en',
  genders: {}, // character -> 'F' | 'M', guessed from the stage directions
};

const scriptListeners = new Set();
export function onScriptChange(fn) {
  scriptListeners.add(fn);
}

// ---------- Tabs ----------

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${btn.dataset.view}`));
    window.dispatchEvent(new CustomEvent('viewchange', { detail: btn.dataset.view }));
  });
});

// ---------- Import ----------

async function readParagraphsFromDocx(arrayBuffer) {
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer }, { ignoreEmptyParagraphs: false });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return [...doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li')].map((p) => p.textContent);
}

async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'doc') {
    throw new AppError('Older .doc files can’t be read. Open it in Word or Pages and save it as .docx or PDF.');
  }
  const data = await file.arrayBuffer();

  if (ext === 'pdf') {
    const lines = await extractPdfLines(pdfjs, new Uint8Array(data));
    if (!lines.length) throw new AppError('No text found in this PDF. It may be a scanned image rather than a text PDF.');
    const elements = parsePositionedLines(lines);
    return elements.some((e) => e.type === 'dialogue') ? elements : parseParagraphs(linesToParagraphs(lines));
  }
  if (ext === 'docx') return parseParagraphs(await readParagraphsFromDocx(data));
  throw new AppError('Please choose a PDF or Word (.docx) file.');
}

// A failed import leaves the current script as it was and shows the problem above it.
async function importFile(file) {
  const hadScript = script.elements.length > 0;
  emptyEl.classList.remove('error');
  setText(emptyEl, 'Reading {file}…', { file: file.name });
  emptyEl.hidden = false;
  try {
    let elements;
    try {
      elements = await parseFile(file);
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(err);
      throw new AppError('This file couldn’t be read. If it’s a script, try saving it again as PDF or .docx.');
    }
    if (!elements.some((e) => e.type === 'dialogue')) {
      throw new AppError('Couldn’t find any character lines in this file. Is it in standard screenplay format (character names in capitals)?');
    }
    script.fileName = file.name;
    script.elements = elements;
    script.extraCharacters = [];
    script.voices = {};
    const characters = listCharacters(elements);
    script.userCharacter = guessUserCharacter(characters, file.name);
    script.language = detectLanguage(elements);
    script.genders = guessGenders(elements, characters.map((c) => c.name));
    emptyEl.hidden = true;
    render();
  } catch (err) {
    setErrorText(emptyEl, err);
    emptyEl.classList.add('error');
    if (!hadScript) bodyEl.innerHTML = '';
  }
}

importBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) importFile(fileInput.files[0]);
  fileInput.value = '';
});

// ---------- Editing ----------

function allCharacters() {
  const names = listCharacters(script.elements).map((c) => c.name);
  for (const extra of script.extraCharacters) if (!names.includes(extra)) names.push(extra);
  return names;
}

function changeSpeaker(el, value) {
  if (value === ACTION) {
    // Keep parentheticals in the text so nothing is lost if this was really a stage direction.
    Object.assign(el, { type: 'action', text: el.parts.map((p) => p.text).join(' ') });
    delete el.speaker;
    delete el.ext;
    delete el.parts;
  } else if (el.type === 'action') {
    Object.assign(el, { type: 'dialogue', speaker: value, ext: '', parts: [{ kind: 'speech', text: el.text }] });
  } else {
    el.speaker = value;
  }
  render();
}

addCharacterForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = newCharacterInput.value.trim().toUpperCase();
  if (name && !allCharacters().includes(name)) script.extraCharacters.push(name);
  newCharacterInput.value = '';
  render();
});

roleSelect.addEventListener('change', () => {
  script.userCharacter = roleSelect.value || null;
  render();
});

for (const [code, name] of Object.entries(UI_LANGUAGES)) languageSelect.add(new Option(name, code));
languageSelect.addEventListener('change', () => {
  script.language = languageSelect.value;
  render(); // voices in the old language are swapped for ones in the new language
});

// ---------- Voices ----------

function partners() {
  return allCharacters().filter((name) => name !== script.userCharacter);
}

// Give every scene partner a voice in the script's language, replacing any that point at an
// engine that isn't available or speak another language. Characters whose gender was guessed get a
// matching voice; the others are balanced between female and male voices.
function ensureVoices() {
  const available = new Set(voiceGroups(script.language).flatMap((g) => g.voices.map((v) => v.id)));
  const used = { F: 0, M: 0 };
  const known = partners().filter((n) => script.genders[n]);
  const unknown = partners().filter((n) => !script.genders[n]);
  for (const name of [...known, ...unknown]) {
    const gender = script.genders[name] ?? (used.F > used.M ? 'M' : used.M > used.F ? 'F' : undefined);
    const current = script.voices[name];
    if (!available.has(current) || voiceLanguage(current) !== script.language) {
      script.voices[name] = defaultVoice(gender ? used[gender] : used.F + used.M, script.language, gender);
    }
    if (gender) used[gender]++;
  }
}

// Which "seat" a character has, so fallback voices still differ between characters.
const slotOf = (name) => Math.max(0, partners().indexOf(name));

function engineStatusText() {
  const { status, message } = engines.kokoro;
  const hasMac = engines.mac.voices.length > 0;
  if (status === 'off') return { key: 'Natural voices (Kokoro) are off. Turn them on in ⚙ Settings; they download about 100 MB once.' };
  if (status === 'loading') return { key: 'Loading built-in voices…' };
  if (status === 'ready') return { key: 'Built-in voices ready.' };
  if (status === 'missing') {
    return { key: hasMac ? 'Built-in voices aren’t installed. Using Mac voices instead.' : 'Built-in voices aren’t installed.', warn: true };
  }
  return {
    key: hasMac ? 'Built-in voices failed to load ({message}). Using Mac voices instead.' : 'Built-in voices failed to load ({message}).',
    vars: { message },
    warn: true,
  };
}

let playingButton = null;

async function playLine(el, button) {
  if (playingButton === button) {
    stopPlayback();
    return;
  }
  stopPlayback();
  button.textContent = '…';
  try {
    const { buffer } = await getLineAudio(el.text, script.voices[el.speaker], { slot: slotOf(el.speaker) });
    stopPlayback();
    playingButton = button;
    button.textContent = '■';
    button.classList.add('playing');
    await playBuffer(buffer);
  } catch (err) {
    setText(prepareStatusEl, err instanceof VoiceError ? '{message}' : 'Couldn’t play that line: {message}', { message: err.message });
    prepareStatusEl.classList.add('warn');
  } finally {
    if (playingButton === button) playingButton = null;
    button.textContent = '▶';
    button.classList.remove('playing');
  }
}

function playButton(el) {
  const btn = document.createElement('button');
  btn.className = 'play';
  btn.textContent = '▶';
  btn.title = t('Hear this line');
  btn.setAttribute('aria-label', t('Hear this line'));
  btn.disabled = !script.voices[el.speaker];
  btn.addEventListener('click', () => playLine(el, btn));
  return btn;
}

function renderVoices() {
  ensureVoices();
  const status = engineStatusText();
  setText(engineStatusEl, status.key, status.vars);
  engineStatusEl.classList.toggle('warn', Boolean(status.warn));

  const groups = voiceGroups(script.language);
  voiceRowsEl.innerHTML = '';
  for (const name of partners()) {
    const row = document.createElement('div');
    row.className = 'voice-row';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;

    const select = document.createElement('select');
    select.setAttribute('aria-label', t('Voice for {name}', { name }));
    for (const g of groups) {
      const group = document.createElement('optgroup');
      group.label = g.label;
      for (const v of g.voices) group.appendChild(new Option(v.label, v.id, false, v.id === script.voices[name]));
      select.appendChild(group);
    }
    select.addEventListener('change', () => {
      script.voices[name] = select.value;
      scriptListeners.forEach((fn) => fn());
    });

    const firstLine = script.elements.find((e) => e.type === 'dialogue' && e.speaker === name);
    // The test sentence is in the script's language, so the voice is heard speaking that language.
    const sample = { speaker: name, text: tFor(script.language, 'Hi, I’m {name}.', { name: name.toLowerCase() }) };
    const test = playButton(firstLine && /[\p{L}]/u.test(firstLine.text) ? firstLine : sample);
    test.title = t('Test this voice');
    test.setAttribute('aria-label', t('Test this voice'));

    const pick = document.createElement('div');
    pick.className = 'pick';
    pick.append(select, test);
    row.append(label, pick);
    voiceRowsEl.appendChild(row);
  }
  if (!groups.length) {
    voiceRowsEl.textContent = t('No voices for this language on this computer yet. Use “Get more voices…” to download some.');
  }
  const partnerLines = script.elements.filter((e) => e.type === 'dialogue' && e.speaker !== script.userCharacter).length;
  prepareBtn.disabled = !groups.length || partnerLines === 0;
}

let prepareRun = 0;

// Generates every partner line in advance. A line that fails doesn't stop the others.
prepareBtn.addEventListener('click', async () => {
  const run = ++prepareRun;
  const lines = script.elements.filter((e) => e.type === 'dialogue' && e.speaker !== script.userCharacter && /[\p{L}\p{N}]/u.test(e.text));
  prepareStatusEl.classList.remove('warn');
  if (!lines.length) {
    setText(prepareStatusEl, 'No partner lines to prepare.');
    return;
  }
  prepareBtn.disabled = true;
  let fellBack = 0;
  let failed = 0;
  let lastError = null;
  try {
    for (const [i, el] of lines.entries()) {
      if (run !== prepareRun) return;
      setText(prepareStatusEl, 'Preparing line {n} of {total}…', { n: i + 1, total: lines.length });
      const requested = script.voices[el.speaker];
      try {
        const { voiceId } = await getLineAudio(el.text, requested, { slot: slotOf(el.speaker) });
        if (voiceId !== requested) fellBack++;
      } catch (err) {
        failed++;
        lastError = err;
      }
    }
    if (failed) {
      setText(prepareStatusEl, failed === 1 ? '1 line couldn’t be prepared: {message}' : '{n} lines couldn’t be prepared: {message}', {
        n: failed,
        message: lastError?.message ?? '',
      });
    } else if (fellBack) {
      setText(prepareStatusEl, lines.length === 1 ? 'The line is ready. It uses a Mac voice because the chosen voice failed.' : 'All {total} lines ready. Some used a Mac voice because the chosen voice failed.', { total: lines.length });
    } else {
      setText(prepareStatusEl, lines.length === 1 ? 'The line is ready.' : 'All {total} lines ready.', { total: lines.length });
    }
    prepareStatusEl.classList.toggle('warn', Boolean(failed || fellBack));
  } finally {
    if (run === prepareRun) prepareBtn.disabled = false;
  }
});

onVoicesChange(() => {
  if (script.elements.length) render();
});
onLanguageChange(() => {
  if (script.elements.length) render();
});
applyTranslations();
setText(emptyEl, 'Import a PDF or Word (.docx) script to get started.');
initVoices();

// ---------- Rendering ----------

function speakerSelect(el, characters) {
  const select = document.createElement('select');
  select.className = 'speaker';
  select.setAttribute('aria-label', t('Who says this'));
  const current = el.type === 'dialogue' ? el.speaker : ACTION;
  for (const name of characters) select.add(new Option(name, name, false, name === current));
  select.add(new Option(t('Stage direction (not spoken)'), ACTION, false, current === ACTION));
  select.addEventListener('change', () => changeSpeaker(el, select.value));
  return select;
}

function render() {
  const characters = allCharacters();
  const counts = Object.fromEntries(listCharacters(script.elements).map((c) => [c.name, c.lines]));
  if (script.userCharacter && !characters.includes(script.userCharacter)) script.userCharacter = null;

  fileNameEl.textContent = script.fileName;
  roleLabel.hidden = addCharacterForm.hidden = helpEl.hidden = voicesPanel.hidden = languageLabel.hidden = false;
  languageSelect.value = script.language;
  renderVoices();

  roleSelect.innerHTML = '';
  roleSelect.add(new Option(t('Choose your character…'), ''));
  for (const name of characters) {
    roleSelect.add(new Option(`${name} (${counts[name] || 0})`, name, false, name === script.userCharacter));
  }

  const total = script.elements.filter((e) => e.type === 'dialogue').length;
  const mine = counts[script.userCharacter] || 0;
  statsEl.textContent = [
    total === 1 ? t('1 line') : t('{n} lines', { n: total }),
    characters.length === 1 ? t('1 character') : t('{n} characters', { n: characters.length }),
    ...(script.userCharacter ? [t('You have {mine}', { mine })] : []),
  ].join(' · ');

  bodyEl.innerHTML = '';
  for (const el of script.elements) {
    const row = document.createElement('div');
    row.className = `el ${el.type}`;

    if (el.type === 'heading') {
      row.textContent = el.text;
    } else {
      const isPartnerLine = el.type === 'dialogue' && el.speaker !== script.userCharacter;
      if (el.type === 'dialogue' && el.speaker === script.userCharacter) {
        row.classList.add('mine');
        // Not only colour: say it, for screen readers and colour-blind users.
        row.setAttribute('aria-label', t('{name} (you)', { name: el.speaker }));
      }
      if (isPartnerLine) row.appendChild(playButton(el));
      else row.appendChild(Object.assign(document.createElement('span'), { className: 'play-spacer' }));
      row.appendChild(speakerSelect(el, characters));
      const text = document.createElement('p');
      if (el.type === 'dialogue') {
        for (const part of el.parts) {
          const span = document.createElement('span');
          span.className = part.kind;
          span.textContent = part.text + ' ';
          text.appendChild(span);
        }
      } else {
        text.textContent = el.text;
      }
      row.appendChild(text);
    }
    bodyEl.appendChild(row);
  }
  scriptListeners.forEach((fn) => fn());
}
