// The camera + microphone stream, shared by Record, Slate, Rehearse and Settings.
import { settings, saveSettings, QUALITIES } from './settings.js';
import { t, onLanguageChange } from './i18n.js';

let stream = null;
let devices = { cameras: [], mics: [] };
let errorKey = null; // translation key of the last problem, if any
let ready = false; // true once the first attempt to open the camera has finished
const listeners = new Set();

export const getStream = () => stream;
export const getDevices = () => devices;
export const getMediaError = () => (errorKey ? t(errorKey) : '');
export const hasCamera = () => Boolean(stream?.getVideoTracks().length);
export const hasMic = () => Boolean(stream?.getAudioTracks().length);

// Called whenever the stream or the device list changes, and right away if the camera is already open.
export function onMediaChange(fn) {
  listeners.add(fn);
  if (ready) fn();
}
const notify = () => listeners.forEach((fn) => fn());

// Plain-language explanations for the browser's camera/mic errors.
function explain(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera or microphone access is blocked. Allow it in System Settings → Privacy & Security (Windows: Settings → Privacy & security), then restart the app.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera or microphone was found. Check that one is connected.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera or microphone is in use by another app (FaceTime, Zoom, Photo Booth…). Close it and restart this app.';
    default:
      return 'The camera or microphone couldn’t be started.';
  }
}

function constraintsFor(cameraId, micId, { video = true, audio = true } = {}) {
  const q = QUALITIES[settings.quality] ?? QUALITIES[1080];
  return {
    video: video && {
      deviceId: cameraId ? { exact: cameraId } : undefined,
      // On a phone or tablet, start with the front (selfie) camera.
      facingMode: cameraId || window.appInfo?.platform !== 'web' ? undefined : 'user',
      width: { ideal: q.width },
      height: { ideal: q.height },
      frameRate: { ideal: 30 },
    },
    // Voice processing makes performances sound pumped and flat; record the raw mic.
    audio: audio && {
      deviceId: micId ? { exact: micId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

// Tries the remembered devices first, then drops whichever one fails, then settles for only a
// camera or only a microphone rather than nothing at all.
async function openStream() {
  const cam = settings.cameraId;
  const mic = settings.micId;
  const attempts = [
    [cam, mic],
    ...(cam ? [['', mic]] : []),
    ...(mic ? [[cam, '']] : []),
    ...(cam || mic ? [['', '']] : []),
  ].map(([c, m]) => constraintsFor(c, m));
  attempts.push(constraintsFor('', mic, { video: false }), constraintsFor(cam, '', { audio: false }));
  attempts.push(constraintsFor('', '', { video: false }), constraintsFor('', '', { audio: false }));

  let firstError = null;
  for (const constraints of attempts) {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia(constraints), error: null };
    } catch (err) {
      firstError ??= err;
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') break; // retrying won't help
    }
  }
  return { stream: null, error: firstError };
}

// Requests are handled one at a time, and only the latest result is kept, so quick changes
// (camera, then quality) never leave an extra camera stream running in the background.
let generation = 0;
let chain = Promise.resolve();

export function startStream() {
  const mine = ++generation;
  chain = chain.then(async () => {
    if (mine !== generation) return; // a newer request replaced this one
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    const result = await openStream();
    if (mine !== generation) {
      result.stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = result.stream;
    errorKey = result.error && !stream ? explain(result.error) : null;
    if (stream && !stream.getVideoTracks().length) errorKey = 'No camera found. You can still rehearse; recording needs a camera.';
    else if (stream && !stream.getAudioTracks().length) errorKey = 'No microphone found. Press Space after each of your lines.';
    await refreshDevices();
  });
  return chain;
}

export async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const named = (kind, fallbackKey) =>
    all
      .filter((d) => d.kind === kind)
      .map((d, i) => ({ id: d.deviceId, label: d.label || t(fallbackKey, { n: i + 1 }) }));
  devices = { cameras: named('videoinput', 'Camera {n}'), mics: named('audioinput', 'Microphone {n}') };
  ready = true;
  notify();
}

export function activeCameraId() {
  return stream?.getVideoTracks()[0]?.getSettings().deviceId ?? '';
}
export function activeMicId() {
  return stream?.getAudioTracks()[0]?.getSettings().deviceId ?? '';
}
export function streamResolution() {
  const s = stream?.getVideoTracks()[0]?.getSettings();
  return s ? `${s.width}×${s.height}` : '';
}

export async function setCamera(id) {
  settings.cameraId = id;
  saveSettings();
  await startStream();
}
export async function setMic(id) {
  settings.micId = id;
  saveSettings();
  await startStream();
}
export async function setQuality(quality) {
  settings.quality = quality;
  saveSettings();
  await startStream();
}

// Fills a <select> with devices, selecting the one in use.
export function fillDeviceSelect(select, list, activeId) {
  select.innerHTML = '';
  for (const d of list) select.add(new Option(d.label, d.id, false, d.id === activeId));
}

navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
// Unnamed devices are labelled "Camera 1"… in the app's language; relabel when it changes.
onLanguageChange(() => ready && refreshDevices());
// Device labels are only exposed after permission is granted, so open the stream first.
startStream();
