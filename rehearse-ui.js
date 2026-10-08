// Rehearse tab: plays the scene with the partner voices and follows along on screen, without recording.
import { script, onScriptChange } from './script-ui.js';
import { setText, onLanguageChange } from './i18n.js';
import { SceneRunner, listScenes } from './scene.js';
import { settings, saveSettings, onSettingsChange } from './settings.js';
import { getStream, hasMic } from './media.js';
import { ScriptFollower } from './script-follow.js';
import { isAnyRecording, onRecordingChange } from './take.js';

const sceneSelect = document.getElementById('rehearse-scene');
const playBtn = document.getElementById('rehearse-play');
const restartBtn = document.getElementById('rehearse-restart');
const nextBtn = document.getElementById('rehearse-next');
const pauseSlider = document.getElementById('pause-slider');
const pauseValue = document.getElementById('pause-value');
const stateEl = document.getElementById('rehearse-state');
const meterFill = document.getElementById('meter-fill');
const emptyEl = document.getElementById('rehearse-empty');
const bodyEl = document.getElementById('rehearse-body');

let scenes = [];
let runner = null;
let resumeFrom = null; // element index to continue from after a pause
let currentLine = null; // the highlighted line
let scriptSignature = '';

const currentScene = () => scenes[Number(sceneSelect.value)] ?? scenes[0];

// `key` is the English text; it is re-translated automatically if the language changes.
function setState(key, vars, kind = '') {
  setText(stateEl, key, vars);
  stateEl.className = `state ${kind}`;
}

// ---------- Script display ----------

const follower = new ScriptFollower(bodyEl, { onLineClick: (i) => play(i) });

function renderScene() {
  follower.render(script.elements, currentScene(), script.userCharacter);
  highlight(currentLine);
}

function highlight(index) {
  currentLine = index;
  follower.highlight(index);
}

// What the rehearsal depends on. Voice changes, engines finishing loading and the like don't
// change it, so they don't interrupt a rehearsal in progress.
function signatureOf() {
  return JSON.stringify([script.fileName, script.userCharacter, script.elements.map((e) => [e.type, e.speaker, e.text])]);
}

function refresh() {
  const signature = signatureOf();
  if (signature === scriptSignature) return;
  scriptSignature = signature;
  stop();
  const ready = Boolean(script.userCharacter) && script.elements.length > 0;
  scenes = ready ? listScenes(script.elements) : [];
  emptyEl.hidden = scenes.length > 0;

  const previous = sceneSelect.value;
  sceneSelect.innerHTML = '';
  scenes.forEach((s, i) => sceneSelect.add(new Option(`${i + 1}. ${s.title}`, i)));
  if ([...sceneSelect.options].some((o) => o.value === previous)) sceneSelect.value = previous;

  resumeFrom = null;
  currentLine = null;
  renderScene();
  updateButtons();
  if (scenes.length) setState('Press Play to start. Click any line to start from there.');
  else setText(stateEl, null);
}

// Re-labels the screen in the new language without stopping or losing your place.
function relabel() {
  const previous = sceneSelect.value;
  scenes = scenes.length ? listScenes(script.elements) : [];
  sceneSelect.innerHTML = '';
  scenes.forEach((s, i) => sceneSelect.add(new Option(`${i + 1}. ${s.title}`, i)));
  sceneSelect.value = previous;
  renderScene();
  updateButtons();
}

// ---------- Playback ----------

function updateButtons() {
  setText(playBtn, runner ? '❚❚ Pause' : resumeFrom !== null ? '▶ Resume' : '▶ Play');
  // Rehearsing while a take is being recorded would play two scenes at once.
  const blocked = !scenes.length || isAnyRecording();
  for (const el of [sceneSelect, playBtn, restartBtn]) el.disabled = blocked;
  nextBtn.disabled = !runner;
}

function play(from = resumeFrom ?? currentScene().start) {
  if (isAnyRecording()) return;
  stop();
  const scene = currentScene();
  const thisRunner = new SceneRunner({
    elements: script.elements,
    userCharacter: script.userCharacter,
    voices: script.voices,
    micStream: getStream(),
    onUpdate: (i, state) => {
      const el = script.elements[i];
      highlight(i);
      if (state === 'partner') setState('{name} is speaking…', { name: el.speaker });
      else if (state === 'novoice') setState('{name} has no voice. Read the line yourself or press Space.', { name: el.speaker }, 'you');
      else if (state === 'failed') setState('{name}’s voice failed for this line. Press Space to go on.', { name: el.speaker }, 'you');
      else if (state === 'listening') setState('Listening… the next cue comes when you pause.', null, 'listening');
      else if (thisRunner.hasMic) setState('Your line. Go ahead when you’re ready.', null, 'you');
      else setState('Your line. Press Space when you’re done.', null, 'you');
    },
    onLevel: (level, threshold) => {
      // The threshold mark sits at one third of the meter.
      meterFill.style.width = `${Math.min(100, (level / (threshold * 3)) * 100)}%`;
    },
    onEnd: (reason) => {
      if (runner !== thisRunner) return;
      runner = null;
      meterFill.style.width = '0';
      if (reason === 'done') {
        resumeFrom = null;
        highlight(null);
        setState('End of scene. Press Play to go again.');
      }
      updateButtons();
    },
  });
  runner = thisRunner;
  resumeFrom = null;
  if (!hasMic()) setState('No microphone found. Press Space after each of your lines.', null, 'you');
  updateButtons();
  runner.run(from, scene.end);
}

function pause() {
  if (!runner) return;
  resumeFrom = runner.index >= 0 ? runner.index : null;
  stop();
  setState('Paused.');
}

function stop() {
  const r = runner;
  runner = null;
  r?.stop();
  meterFill.style.width = '0';
  updateButtons();
}

playBtn.addEventListener('click', () => {
  playBtn.blur(); // so a later Space can't "click" it
  runner ? pause() : play();
});
restartBtn.addEventListener('click', () => {
  restartBtn.blur();
  resumeFrom = null;
  highlight(null);
  play(currentScene().start);
});
nextBtn.addEventListener('click', () => runner?.next());
sceneSelect.addEventListener('change', () => {
  stop();
  resumeFrom = null;
  currentLine = null;
  renderScene();
  setState('Press Play to start. Click any line to start from there.');
  sceneSelect.blur();
});

function showPause() {
  pauseSlider.value = settings.pauseMs / 1000;
  pauseValue.textContent = `${(settings.pauseMs / 1000).toFixed(1)} s`;
}
pauseSlider.addEventListener('input', () => {
  settings.pauseMs = Number(pauseSlider.value) * 1000;
  saveSettings();
  showPause();
});
pauseSlider.addEventListener('change', () => pauseSlider.blur());
// Keep in sync with the same setting in the Settings window.
onSettingsChange(showPause);
showPause();

// Pause if the user switches to another tab mid-scene, or a recording starts.
window.addEventListener('viewchange', (e) => {
  if (e.detail !== 'rehearse') pause();
});
onRecordingChange(() => {
  if (isAnyRecording()) pause();
  updateButtons();
});

onScriptChange(refresh);
onLanguageChange(relabel);
refresh();
