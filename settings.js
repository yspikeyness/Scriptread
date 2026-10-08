// All user settings, remembered between launches.
const KEY = 'selftape-settings';

const DEFAULTS = {
  // Interface language: '' follows the computer, or 'en' | 'es' | 'pt'
  uiLanguage: '',
  // Cues
  pauseMs: 1200,
  sensitivity: 5,
  // Devices (empty = system default)
  cameraId: '',
  micId: '',
  // Video
  quality: '1080', // '2160' | '1080' | '720' | '480'
  format: 'mp4', // 'mp4' | 'webm'
  // Saving
  saveFolder: '', // empty = ask every time
  fileTemplate: '{name}_{role}_{clip}_Take{take}',
  // Slate checklist: [{ id, label, value, on, custom }]
  slate: null,
  // Last saved take number per "script|role|clip"
  takeCounts: {},
  // iPhone/iPad only: use the downloadable Kokoro voices
  kokoroOnDevice: false,
};

// Saved settings are checked field by field, so a damaged or old-format file can't stop the app
// from starting; anything that doesn't look right falls back to its default.
function loadSaved() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    localStorage.removeItem(KEY);
    return {};
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const ok = {};
  const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  if (['', 'en', 'es', 'pt'].includes(saved.uiLanguage)) ok.uiLanguage = saved.uiLanguage;
  if (isNum(saved.pauseMs, 300, 5000)) ok.pauseMs = saved.pauseMs;
  if (isNum(saved.sensitivity, 1, 10)) ok.sensitivity = Math.round(saved.sensitivity);
  for (const k of ['cameraId', 'micId', 'saveFolder', 'fileTemplate']) if (typeof saved[k] === 'string') ok[k] = saved[k];
  if (String(saved.quality) in QUALITIES) ok.quality = String(saved.quality);
  if (['mp4', 'webm'].includes(saved.format)) ok.format = saved.format;
  if (typeof saved.kokoroOnDevice === 'boolean') ok.kokoroOnDevice = saved.kokoroOnDevice;
  if (Array.isArray(saved.slate)) {
    ok.slate = saved.slate.filter((i) => i && typeof i === 'object' && typeof i.id === 'string' && typeof i.label === 'string');
  }
  if (saved.takeCounts && typeof saved.takeCounts === 'object' && !Array.isArray(saved.takeCounts)) {
    ok.takeCounts = Object.fromEntries(Object.entries(saved.takeCounts).filter(([, n]) => Number.isInteger(n) && n > 0));
  }
  return ok;
}

const listeners = new Set();
export function onSettingsChange(fn) {
  listeners.add(fn);
}

export function saveSettings() {
  localStorage.setItem(KEY, JSON.stringify(settings));
  listeners.forEach((fn) => fn());
}

// ---------- Video quality ----------

export const QUALITIES = {
  2160: { label: '4K (2160p)', width: 3840, height: 2160, bitrate: 35_000_000 },
  1080: { label: 'Full HD (1080p)', width: 1920, height: 1080, bitrate: 8_000_000 },
  720: { label: 'HD (720p)', width: 1280, height: 720, bitrate: 5_000_000 },
  480: { label: 'SD (480p)', width: 854, height: 480, bitrate: 2_500_000 },
};

export const settings = { ...DEFAULTS, takeCounts: {}, ...loadSaved() };

// ---------- File names ----------

export const FILE_TAGS = {
  name: 'Your name (from the Slate tab)',
  role: 'Your character',
  project: 'Script file name',
  clip: 'Scene1, Scene2… or Slate',
  take: 'Take number',
  date: 'Date (2026-10-07)',
  time: 'Time (14-30)',
};

const SEPARATORS = /[_\-\s.]/;
const MAX_NAME_LENGTH = 150;

// Fills in the template. Separators you typed are kept as they are; only those left around an empty
// tag are tidied up ("{name}_{role}_Take1" with no role becomes "Bruno_Take1", not "Bruno__Take1").
export function buildFileName(template, values) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const all = {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}`,
    ...values,
  };
  const EMPTY = '\u0000';
  let name = (template || DEFAULTS.fileTemplate).replace(/\{(\w+)\}/g, (m, tag) => {
    if (!(tag in all)) return m.replace(/[{}]/g, '');
    const value = String(all[tag] ?? '').trim();
    return value || EMPTY;
  });
  // Drop each empty tag together with the separators on one side of it.
  name = name.replace(/([_\-\s.]*)\u0000([_\-\s.]*)/g, (m, before, after) =>
    before && after ? (before.length >= after.length ? before : after) : '',
  );
  name = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '') // characters not allowed in file names
    .replace(new RegExp(`^${SEPARATORS.source}+|${SEPARATORS.source}+$`, 'g'), '');
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH).replace(new RegExp(`${SEPARATORS.source}+$`), '');
  return name || 'selftape';
}
