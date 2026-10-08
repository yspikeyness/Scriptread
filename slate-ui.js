// Slate tab: a checklist of what to say on the slate, shown as cue cards while you record it.
import { settings, saveSettings } from './settings.js';
import { t, onLanguageChange } from './i18n.js';
import { getStream, onMediaChange } from './media.js';
import { script, onScriptChange } from './script-ui.js';
import { TakeRecorder } from './take.js';
import { setStatus } from './recorder.js';
import { createLevelMeter, listenForTurn, holdFor, setSpaceTarget, clearSpaceTarget } from './scene.js';
import { audioContext } from './voices.js';

// Silent actions (profiles, full body) can't be heard finishing, so they move on after this long.
const ACTION_HOLD_MS = 5000;

// The things casting most often asks for. Items without an answer box are actions, not facts.
const DEFAULT_ITEMS = [
  { id: 'name', label: 'Name', placeholder: 'Your name', on: true },
  { id: 'height', label: 'Height', placeholder: 'e.g. 5\'11"' },
  { id: 'role', label: 'Role', placeholder: 'Leave blank to use your character from the script' },
  { id: 'agency', label: 'Agency / representation', placeholder: 'e.g. ABC Talent' },
  { id: 'based', label: 'Based in', placeholder: 'e.g. Los Angeles' },
  { id: 'current', label: 'Current location', placeholder: 'Where you are right now' },
  { id: 'availability', label: 'Availability', placeholder: 'e.g. Available for all shoot dates' },
  { id: 'union', label: 'Union status', placeholder: 'e.g. SAG-AFTRA' },
  { id: 'work', label: 'Work authorization', placeholder: 'e.g. US citizen' },
  { id: 'social', label: 'Social media', placeholder: 'e.g. @yourhandle' },
  { id: 'profiles', label: 'Profiles (turn left, then right)', noValue: true },
  { id: 'fullbody', label: 'Full body shot (step back, head to toe)', noValue: true },
];

const itemsEl = document.getElementById('slate-items');
const addForm = document.getElementById('slate-add');
const newInput = document.getElementById('slate-new');
const cueList = document.getElementById('slate-cue-list');
const cueEmpty = document.getElementById('slate-cue-empty');
const overlay = document.getElementById('slate-overlay');
const overlayCount = document.getElementById('slate-overlay-count');
const overlayLabel = document.getElementById('slate-overlay-label');
const overlayValue = document.getElementById('slate-overlay-value');
const overlayNext = document.getElementById('slate-overlay-next');
const nextBtn = document.getElementById('slate-next');
// Touch screens have no Space bar: tap the cue (or the Next button) to move on.
nextBtn.addEventListener('click', () => cueRun?.next());
overlay.addEventListener('click', () => cueRun?.next());

let currentCue = -1; // index into the ticked items while recording; -1 when idle
let reviewing = false;
let recording = false; // the checklist is locked while a slate is being recorded
let runItems = null; // the items being cued during a take (fixed when it starts)
let hasMicForRun = true;

// Merge saved answers with the defaults so new default items appear after updates.
function loadItems() {
  const saved = settings.slate ?? [];
  const byId = new Map(saved.map((i) => [i.id, i]));
  const clean = (i) => ({ value: typeof i?.value === 'string' ? i.value : '', on: Boolean(i?.on) });
  const items = DEFAULT_ITEMS.map((d) => ({ ...d, on: Boolean(d.on), value: '', ...(byId.has(d.id) ? clean(byId.get(d.id)) : {}) }));
  return items.concat(saved.filter((i) => i.custom).map((i) => ({ id: i.id, label: i.label, custom: true, ...clean(i) })));
}

let items = loadItems();

function persist() {
  settings.slate = items.map(({ id, label, value, on, custom }) => ({ id, label, value, on, custom }));
  saveSettings();
}

function cueValue(item) {
  if (item.id === 'role') return item.value || script.userCharacter || '';
  return item.value;
}

// While recording, the cues come from the list as it was when the take started.
const chosenItems = () => runItems ?? items.filter((i) => i.on);

// Built-in items are stored in English and shown in the app's language; your own items stay as typed.
const labelOf = (item) => (item.custom ? item.label : t(item.label));

function renderCues() {
  cueList.innerHTML = '';
  const chosen = chosenItems();
  cueEmpty.hidden = chosen.length > 0;
  for (const [i, item] of chosen.entries()) {
    const li = document.createElement('li');
    li.classList.toggle('current', i === currentCue);
    li.classList.toggle('done', currentCue >= 0 && i < currentCue);
    const value = cueValue(item);
    if (value && !item.noValue) {
      const label = document.createElement('span');
      label.className = 'cue-label';
      label.textContent = labelOf(item);
      const val = document.createElement('span');
      val.className = 'cue-value';
      val.textContent = value;
      li.append(label, val);
    } else {
      li.textContent = labelOf(item);
    }
    cueList.appendChild(li);
  }
  renderOverlay();
}

// The big cue over the video: the current item while recording, the first one before you start.
function renderOverlay() {
  const chosen = chosenItems();
  overlay.hidden = reviewing || !chosen.length;
  if (overlay.hidden) return;
  const finished = currentCue >= chosen.length;
  const index = Math.max(0, currentCue);
  overlay.classList.toggle('waiting', currentCue < 0);

  if (finished) {
    overlayCount.textContent = '';
    overlayLabel.textContent = t('That’s everything');
    overlayValue.textContent = t('Press Stop when you’re done');
    overlayNext.textContent = '';
    return;
  }
  const item = chosen[index];
  const value = cueValue(item);
  overlayCount.textContent =
    currentCue < 0 ? t('Press Record to start') : t('{n} of {total}', { n: index + 1, total: chosen.length });
  if (value && !item.noValue) {
    overlayLabel.textContent = labelOf(item);
    overlayValue.textContent = value;
  } else {
    overlayLabel.textContent = '';
    overlayValue.textContent = labelOf(item);
  }
  const next = chosen[index + 1];
  if (currentCue >= 0 && !hasMicForRun && !item.noValue) overlayNext.textContent = t('Press Space for the next item');
  else overlayNext.textContent = next ? t('Next: {item}', { item: labelOf(next) }) : '';
}

function renderItems() {
  itemsEl.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'slate-item';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = item.on;
    box.id = `slate-${item.id}`;
    box.disabled = recording;
    box.addEventListener('change', () => {
      item.on = box.checked;
      persist();
      renderCues();
    });

    const label = document.createElement('label');
    label.className = 'item-label';
    label.htmlFor = box.id;
    label.textContent = labelOf(item);
    row.append(box, label);

    if (item.custom) {
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.title = t('Remove this item');
      remove.setAttribute('aria-label', t('Remove this item'));
      remove.textContent = '×';
      remove.disabled = recording;
      remove.addEventListener('click', () => {
        items = items.filter((i) => i !== item);
        persist();
        renderItems();
        renderCues();
      });
      row.appendChild(remove);
    } else {
      row.appendChild(document.createElement('span'));
    }

    if (!item.noValue) {
      const input = document.createElement('input');
      input.className = 'item-value';
      input.value = item.value;
      input.placeholder = t(item.placeholder ?? 'Your answer');
      input.setAttribute('aria-label', labelOf(item));
      input.disabled = recording;
      input.addEventListener('input', () => {
        item.value = input.value;
        // Typing an answer ticks the item, since you'll almost always want to say it.
        if (input.value && !item.on) {
          item.on = box.checked = true;
        }
        persist();
        renderCues();
      });
      row.appendChild(input);
    }
    itemsEl.appendChild(row);
  }
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (recording) return;
  const label = newInput.value.trim();
  if (!label) return;
  items.push({ id: `custom-${Date.now()}`, label, value: '', on: true, custom: true });
  newInput.value = '';
  persist();
  renderItems();
  renderCues();
});

// ---------- Moving through the cues while recording ----------

let cueRun = null;

async function runCues() {
  const run = { stopped: false, wait: null, next: () => run.wait?.finish() };
  cueRun = run;
  const list = (runItems = items.filter((i) => i.on));
  const ctx = audioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  if (run.stopped) return; // Stop was pressed while the audio was waking up
  const meter = createLevelMeter(ctx, getStream());
  hasMicForRun = Boolean(meter);
  setSpaceTarget(run);

  for (let i = 0; i < list.length && !run.stopped; i++) {
    currentCue = i;
    renderCues();
    const item = list[i];
    // Spoken items wait for you to speak and pause; silent ones move on by themselves; with no mic, Space only.
    run.wait = item.noValue ? holdFor(ACTION_HOLD_MS) : meter ? listenForTurn(meter) : holdFor(Infinity);
    await run.wait.done;
  }
  meter?.stop();
  clearSpaceTarget(run);
  if (!run.stopped) {
    currentCue = list.length;
    renderCues();
  }
}

function stopCues() {
  if (cueRun) {
    cueRun.stopped = true;
    cueRun.next();
    clearSpaceTarget(cueRun);
    cueRun = null;
  }
  runItems = null;
  currentCue = -1;
  hasMicForRun = true;
  renderCues();
}

function setRecording(on) {
  recording = on;
  nextBtn.hidden = !on;
  overlay.classList.toggle('tappable', on);
  newInput.disabled = on;
  addForm.querySelector('button').disabled = on;
  renderItems();
}

// ---------- Recording ----------

const take = new TakeRecorder(
  {
    preview: document.getElementById('slate-preview'),
    playback: document.getElementById('slate-playback'),
    recordBtn: document.getElementById('slate-record-btn'),
    badge: document.getElementById('slate-rec-badge'),
    timer: document.getElementById('slate-timer'),
    recordControls: document.getElementById('slate-record-controls'),
    reviewControls: document.getElementById('slate-review-controls'),
    saveBtn: document.getElementById('slate-save-btn'),
    discardBtn: document.getElementById('slate-discard-btn'),
    note: document.getElementById('slate-note'),
  },
  {
    setStatus,
    clip: () => 'Slate',
    started: () => {
      setRecording(true);
      runCues();
    },
    stopped: () => {
      stopCues();
      setRecording(false);
    },
    reviewing: (on) => {
      reviewing = on;
      renderOverlay();
    },
  },
);

onMediaChange(() => take.attachPreview());
onScriptChange(renderCues);
if (getStream()) take.attachPreview();
onLanguageChange(() => {
  renderItems();
  renderCues();
});
renderItems();
renderCues();
