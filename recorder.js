// Record tab: records a take, optionally playing the scene with the partner voices.
import { script, onScriptChange } from './script-ui.js';
import { SceneRunner, listScenes } from './scene.js';
import { audioContext } from './voices.js';
import { ScriptFollower } from './script-follow.js';
import {
  getStream,
  getDevices,
  getMediaError,
  hasCamera,
  onMediaChange,
  activeCameraId,
  activeMicId,
  streamResolution,
  setCamera,
  setMic,
  fillDeviceSelect,
} from './media.js';
import { TakeRecorder, isAnyRecording, onRecordingChange } from './take.js';
import { t, setText, onLanguageChange } from './i18n.js';

const cameraSelect = document.getElementById('camera-select');
const micSelect = document.getElementById('mic-select');
const statusEl = document.getElementById('status');
const sceneRecordEl = document.getElementById('scene-record');
const playSceneBox = document.getElementById('play-scene');
const recordSceneSelect = document.getElementById('record-scene');
const mixPartnerBox = document.getElementById('mix-partner');
const showLinesBox = document.getElementById('show-lines');
const linesPanel = document.getElementById('record-lines');
const follower = new ScriptFollower(document.getElementById('record-lines-body'));
const nextBtn = document.getElementById('record-next');
nextBtn.addEventListener('click', () => runner?.next());

let runner = null;
let currentLine = null; // index of the line being played during a take, for re-highlighting
let reviewing = false;

// The header status line, shared by the Record and Slate tabs. `key` is the English text.
export function setStatus(key, vars, isError = false) {
  setText(statusEl, key, vars);
  statusEl.classList.toggle('error', isError);
}

// ---------- Devices ----------

cameraSelect.addEventListener('change', () => setCamera(cameraSelect.value));
micSelect.addEventListener('change', () => setMic(micSelect.value));

// Changing the camera or mic restarts the stream, which would end a take in any tab.
function lockDevices() {
  cameraSelect.disabled = micSelect.disabled = isAnyRecording();
}
onRecordingChange(lockDevices);

// ---------- Playing the scene during a take ----------

const currentScene = () => listScenes(script.elements)[Number(recordSceneSelect.value)];
const sceneWanted = () => !sceneRecordEl.hidden && playSceneBox.checked;

function refreshSceneOptions() {
  const scenes = script.userCharacter ? listScenes(script.elements) : [];
  sceneRecordEl.hidden = !scenes.length;
  const previous = recordSceneSelect.value;
  recordSceneSelect.innerHTML = '';
  scenes.forEach((s, i) => recordSceneSelect.add(new Option(`${i + 1}. ${s.title}`, i)));
  if ([...recordSceneSelect.options].some((o) => o.value === previous)) recordSceneSelect.value = previous;
  renderLines();
}

// The optional script panel beside the camera, in case a line slips your mind mid-take.
function renderLines() {
  linesPanel.hidden = sceneRecordEl.hidden || !showLinesBox.checked;
  follower.render(script.elements, currentScene(), script.userCharacter);
  if (currentLine !== null) follower.highlight(currentLine);
}

onScriptChange(refreshSceneOptions);
onLanguageChange(refreshSceneOptions);
recordSceneSelect.addEventListener('change', renderLines);
showLinesBox.addEventListener('change', renderLines);

// Camera video plus mic audio, with partner voices mixed in if requested.
function buildSceneStream() {
  const stream = getStream();
  const ctx = audioContext();
  const dest = ctx.createMediaStreamDestination();
  const nodes = [];
  if (stream.getAudioTracks().length) {
    const mic = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    mic.connect(dest);
    nodes.push(mic);
  }
  let partnerOutput = null;
  if (mixPartnerBox.checked) {
    // Quieter than the actor, like a reader standing off camera.
    partnerOutput = ctx.createGain();
    partnerOutput.gain.value = 0.6;
    partnerOutput.connect(dest);
    nodes.push(partnerOutput);
  }
  return {
    stream: new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]),
    partnerOutput,
    cleanup: () => nodes.forEach((n) => n.disconnect()),
  };
}

let pendingPartnerOutput = null;

function startScene() {
  const scene = currentScene();
  const thisRunner = new SceneRunner({
    elements: script.elements,
    userCharacter: script.userCharacter,
    voices: script.voices,
    micStream: getStream(),
    extraOutput: pendingPartnerOutput,
    onUpdate: (i, state) => {
      const el = script.elements[i];
      currentLine = i;
      follower.highlight(i);
      if (state === 'partner') setStatus('{name}…', { name: el.speaker });
      else if (state === 'novoice') setStatus('{name} has no voice. Read the line yourself or press Space.', { name: el.speaker });
      else if (state === 'failed') setStatus('{name}’s voice failed for this line. Press Space to go on.', { name: el.speaker });
      else if (state === 'listening') setStatus('Your line · listening');
      else setStatus(thisRunner.hasMic ? 'Your line' : 'Your line. Press Space when you’re done.');
    },
    onEnd: (reason) => {
      if (runner === thisRunner && reason === 'done') setStatus('Scene finished. Press Stop when you’re ready.');
    },
  });
  runner = thisRunner;
  nextBtn.hidden = false; // for touch screens, where there's no Space bar
  runner.run(scene.start, scene.end);
}

function stopScene() {
  runner?.stop();
  runner = null;
  nextBtn.hidden = true;
  currentLine = null;
  follower.highlight(null);
}

// ---------- Recording ----------

const take = new TakeRecorder(
  {
    preview: document.getElementById('preview'),
    playback: document.getElementById('playback'),
    recordBtn: document.getElementById('record-btn'),
    badge: document.getElementById('rec-badge'),
    timer: document.getElementById('timer'),
    recordControls: document.getElementById('record-controls'),
    reviewControls: document.getElementById('review-controls'),
    saveBtn: document.getElementById('save-btn'),
    discardBtn: document.getElementById('discard-btn'),
    note: document.getElementById('format-note'),
  },
  {
    lockWhileBusy: [playSceneBox, recordSceneSelect, mixPartnerBox],
    setStatus,
    prepare() {
      if (!sceneWanted()) return {};
      const built = buildSceneStream();
      pendingPartnerOutput = built.partnerOutput;
      return built;
    },
    started() {
      follower.highlight(null);
      if (sceneWanted()) startScene();
    },
    stopped: stopScene,
    reviewing: (on) => {
      reviewing = on;
      if (!on) showCameraStatus();
    },
    clip() {
      return sceneWanted() ? `Scene${Number(recordSceneSelect.value) + 1}` : '';
    },
  },
);

function showCameraStatus() {
  if (take.isRecording() || reviewing || runner) return; // don't overwrite what's happening now
  const err = getMediaError();
  if (err && !getStream()) setStatus('Camera/mic unavailable: {message}', { message: err }, true);
  else if (!hasCamera()) setStatus('No camera found. You can still rehearse; recording needs a camera.', null, true);
  else if (err) setStatus('{ready} · {resolution} · {warning}', { ready: t('Ready'), resolution: streamResolution(), warning: err });
  else setStatus('Ready · {resolution}', { resolution: streamResolution() });
}

setStatus('Starting camera…');

// Registered after `take` exists, since it may run immediately.
onMediaChange(() => {
  const { cameras, mics } = getDevices();
  fillDeviceSelect(cameraSelect, cameras, activeCameraId());
  fillDeviceSelect(micSelect, mics, activeMicId());
  lockDevices();
  take.attachPreview();
  showCameraStatus();
});
// The "Ready" line includes texts translated when it's built (device warnings), so rebuild it.
onLanguageChange(() => getStream() && showCameraStatus());
onRecordingChange(() => !isAnyRecording() && !reviewing && showCameraStatus());
