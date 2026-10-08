// Settings window: devices, video quality/format, where and how takes are saved, and cue detection.
import { createLevelMeter } from './scene.js';
import { settings, saveSettings, onSettingsChange, QUALITIES, FILE_TAGS, buildFileName } from './settings.js';
import { audioContext, setKokoroEnabled } from './voices.js';
import {
  getStream,
  getDevices,
  onMediaChange,
  activeCameraId,
  activeMicId,
  streamResolution,
  setCamera,
  setMic,
  setQuality,
  fillDeviceSelect,
} from './media.js';
import { isAnyRecording, onRecordingChange, slateName } from './take.js';
import { script } from './script-ui.js';
import { VERSION, BUILD, BUILD_DATE } from './version.js';
import { t, setText, UI_LANGUAGES, setUiLanguage, onLanguageChange } from './i18n.js';

const $ = (id) => document.getElementById(id);
const dialog = $('settings-dialog');
const cameraSelect = $('settings-camera');
const micSelect = $('settings-mic');
const qualitySelect = $('settings-quality');
const formatSelect = $('settings-format');
const resolutionNote = $('settings-resolution');
const saveMode = $('settings-save-mode');
const folderEl = $('settings-folder');
const chooseFolderBtn = $('settings-choose-folder');
const templateInput = $('settings-template');
const tagsEl = $('settings-tags');
const exampleEl = $('settings-example');
const sensitivitySlider = $('sensitivity-slider');
const sensitivityValue = $('sensitivity-value');
const pauseSlider = $('settings-pause-slider');
const pauseValue = $('settings-pause-value');
const meterFill = $('settings-meter-fill');
const meterNote = $('settings-meter-note');
const uiLanguageSelect = $('settings-ui-language');
const isWeb = window.appInfo?.platform === 'web';
// iPhone/iPad: no folders to choose (Save opens the share sheet), and Kokoro is optional.
$('settings-folder-section').hidden = isWeb;
$('settings-share-note').hidden = !isWeb;
$('settings-kokoro-section').hidden = !isWeb;
const kokoroBox = $('settings-kokoro');
kokoroBox.addEventListener('change', () => {
  setKokoroEnabled(kokoroBox.checked);
  saveSettings();
});

function fillLabels() {
  qualitySelect.innerHTML = '';
  for (const [value, q] of Object.entries(QUALITIES).sort((a, b) => b[0] - a[0])) {
    qualitySelect.add(new Option(t(q.label), value));
  }
  qualitySelect.value = settings.quality;
  uiLanguageSelect.innerHTML = '';
  uiLanguageSelect.add(new Option(t('Same as this computer'), ''));
  for (const [code, name] of Object.entries(UI_LANGUAGES)) uiLanguageSelect.add(new Option(name, code));
  uiLanguageSelect.value = settings.uiLanguage;
  for (const btn of tagsEl.children) btn.title = t(FILE_TAGS[btn.dataset.tag]);
}

uiLanguageSelect.addEventListener('change', () => setUiLanguage(uiLanguageSelect.value));
onLanguageChange(() => {
  fillLabels();

// Which build this is, so you can tell when the app has been updated.
const versionEl = $('app-version');
const showVersion = () => setText(versionEl, 'Version {version} (build {build})', { version: VERSION, build: BUILD });
versionEl.title = BUILD_DATE;
showVersion();
  if (dialog.open) show();
});

for (const tag of Object.keys(FILE_TAGS)) {
  const btn = document.createElement('button');
  btn.textContent = `{${tag}}`;
  btn.dataset.tag = tag;
  btn.addEventListener('click', () => {
    // Insert the tag where the cursor is.
    const end = templateInput.value.length;
    templateInput.setRangeText(`{${tag}}`, templateInput.selectionStart ?? end, templateInput.selectionEnd ?? end, 'end');
    templateInput.focus();
    templateInput.dispatchEvent(new Event('input'));
  });
  tagsEl.appendChild(btn);
}
fillLabels();

// ---------- Showing current values ----------

function showDevices() {
  const { cameras, mics } = getDevices();
  fillDeviceSelect(cameraSelect, cameras, activeCameraId());
  fillDeviceSelect(micSelect, mics, activeMicId());
  const resolution = streamResolution();
  const wanted = QUALITIES[settings.quality];
  resolutionNote.textContent = resolution
    ? t('Camera is sending {resolution}.', { resolution }) +
      (wanted && resolution !== `${wanted.width}×${wanted.height}` ? ' ' + t('This camera may not support the chosen quality.') : '')
    : '';
}

function showExample() {
  const ext = settings.format === 'webm' ? 'webm' : 'mp4';
  exampleEl.textContent = `${buildFileName(settings.fileTemplate, {
    name: slateName() || t('YourName'),
    role: script.userCharacter || t('ROLE'),
    project: script.fileName.replace(/\.[^.]+$/, '') || t('Project'),
    clip: 'Scene1',
    take: 1,
  })}.${ext}`;
}

function show() {
  showDevices();
  qualitySelect.value = settings.quality;
  formatSelect.value = settings.format;
  saveMode.value = settings.saveFolder ? 'folder' : 'ask';
  // The path is shown right-aligned so its end stays visible; the mark keeps a leading "/" in place.
  folderEl.textContent = settings.saveFolder ? `\u200E${settings.saveFolder}\u200E` : '';
  folderEl.title = settings.saveFolder;
  chooseFolderBtn.hidden = !settings.saveFolder;
  if (document.activeElement !== templateInput) templateInput.value = settings.fileTemplate;
  showExample();
  kokoroBox.checked = settings.kokoroOnDevice;
  sensitivitySlider.value = settings.sensitivity;
  sensitivityValue.textContent = `${settings.sensitivity} / 10`;
  pauseSlider.value = settings.pauseMs / 1000;
  pauseValue.textContent = `${(settings.pauseMs / 1000).toFixed(1)} s`;
  lockDeviceSettings();
}

// Changing these restarts the camera, which would cut off a take in progress.
function lockDeviceSettings() {
  for (const el of [cameraSelect, micSelect, qualitySelect]) el.disabled = isAnyRecording();
}
onRecordingChange(lockDeviceSettings);

// ---------- Changes ----------

cameraSelect.addEventListener('change', () => setCamera(cameraSelect.value));
micSelect.addEventListener('change', () => setMic(micSelect.value));
qualitySelect.addEventListener('change', () => setQuality(qualitySelect.value));
formatSelect.addEventListener('change', () => {
  settings.format = formatSelect.value;
  saveSettings();
});

async function chooseFolder() {
  const folder = await window.files.chooseFolder(t('Choose where to save your takes'));
  if (folder) settings.saveFolder = folder;
  saveSettings();
  show();
}
saveMode.addEventListener('change', () => {
  if (saveMode.value === 'folder') {
    chooseFolder();
  } else {
    settings.saveFolder = '';
    saveSettings();
  }
});
chooseFolderBtn.addEventListener('click', chooseFolder);

templateInput.addEventListener('input', () => {
  settings.fileTemplate = templateInput.value;
  saveSettings();
});

sensitivitySlider.addEventListener('input', () => {
  settings.sensitivity = Number(sensitivitySlider.value);
  saveSettings();
});
pauseSlider.addEventListener('input', () => {
  settings.pauseMs = Number(pauseSlider.value) * 1000;
  saveSettings();
});

onSettingsChange(() => dialog.open && show());

// ---------- Live mic meter ----------

let meter = null;
let meterTimer = null;

async function startMeter() {
  const ctx = audioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  meter = createLevelMeter(ctx, getStream());
  if (!meter) {
    setText(meterNote, 'No microphone found. Check the Microphone choice above.');
    return;
  }
  setText(meterNote, 'Talk normally: the green bar should pass the line while you speak, and drop below it when you stop.');
  meterTimer = setInterval(() => {
    const { level, threshold } = meter.read();
    meterFill.style.width = `${Math.min(100, (level / (threshold * 3)) * 100)}%`;
  }, 50);
}

function stopMeter() {
  clearInterval(meterTimer);
  meter?.stop();
  meter = null;
  meterFill.style.width = '0';
}

// The camera or mic changed while the window is open: refresh the lists and the meter.
onMediaChange(() => {
  if (!dialog.open) return;
  showDevices();
  stopMeter();
  startMeter();
});

$('settings-btn').addEventListener('click', () => {
  show();
  dialog.showModal();
  startMeter();
});
$('settings-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', stopMeter);
