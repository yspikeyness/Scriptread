// Scene-partner voices: Kokoro (built into the app), optional downloaded Piper voices, and macOS
// system voices, which are also the fallback if another engine fails.
// Voice ids look like "kokoro:af_heart", "piper:en_US-lessac-medium", "piper:en_GB-vctk-medium#3"
// (speaker 3 of a multi-speaker model) or "mac:Ava (Premium)".

import { t } from './i18n.js';
import { settings } from './settings.js';

// The iPhone/iPad (web) version has no `say` command: its "device voices" are spoken live by the
// system and can't be turned into audio data, so they're played rather than prepared.
const DEVICE_VOICES_ARE_LIVE = Boolean(window.macVoices?.realtime);
const IS_WEB = window.appInfo?.platform === 'web';

// Script languages the app supports.
export const SCRIPT_LANGUAGES = ['en', 'es', 'pt'];

// Kokoro voices, ordered best-first by Kokoro's own quality grades within each language.
// [id, name, accent, sex, language]. Spanish and Portuguese voices are offered in two accents each;
// "@es-419" / "@pt" on the id picks the pronunciation (see tts-worker.js).
const KOKORO_TABLE = [
  ['af_heart', 'Heart', 'US', 'F', 'en'], ['af_bella', 'Bella', 'US', 'F', 'en'], ['af_nicole', 'Nicole', 'US', 'F', 'en'],
  ['bf_emma', 'Emma', 'UK', 'F', 'en'], ['am_michael', 'Michael', 'US', 'M', 'en'], ['am_fenrir', 'Fenrir', 'US', 'M', 'en'],
  ['am_puck', 'Puck', 'US', 'M', 'en'], ['af_aoede', 'Aoede', 'US', 'F', 'en'], ['af_kore', 'Kore', 'US', 'F', 'en'],
  ['af_sarah', 'Sarah', 'US', 'F', 'en'], ['bm_george', 'George', 'UK', 'M', 'en'], ['bm_fable', 'Fable', 'UK', 'M', 'en'],
  ['af_alloy', 'Alloy', 'US', 'F', 'en'], ['af_nova', 'Nova', 'US', 'F', 'en'], ['bf_isabella', 'Isabella', 'UK', 'F', 'en'],
  ['af_sky', 'Sky', 'US', 'F', 'en'], ['bm_lewis', 'Lewis', 'UK', 'M', 'en'], ['am_echo', 'Echo', 'US', 'M', 'en'],
  ['am_eric', 'Eric', 'US', 'M', 'en'], ['am_liam', 'Liam', 'US', 'M', 'en'], ['am_onyx', 'Onyx', 'US', 'M', 'en'],
  ['bm_daniel', 'Daniel', 'UK', 'M', 'en'], ['af_jessica', 'Jessica', 'US', 'F', 'en'], ['af_river', 'River', 'US', 'F', 'en'],
  ['bf_alice', 'Alice', 'UK', 'F', 'en'], ['bf_lily', 'Lily', 'UK', 'F', 'en'], ['am_santa', 'Santa', 'US', 'M', 'en'],
  ['am_adam', 'Adam', 'US', 'M', 'en'],
  ['ef_dora@es-419', 'Dora', 'Latin America', 'F', 'es'], ['em_alex@es-419', 'Alex', 'Latin America', 'M', 'es'],
  ['em_santa@es-419', 'Santa', 'Latin America', 'M', 'es'],
  ['ef_dora', 'Dora', 'Spain', 'F', 'es'], ['em_alex', 'Alex', 'Spain', 'M', 'es'], ['em_santa', 'Santa', 'Spain', 'M', 'es'],
  ['pf_dora', 'Dora', 'Brazil', 'F', 'pt'], ['pm_alex', 'Alex', 'Brazil', 'M', 'pt'], ['pm_santa', 'Santa', 'Brazil', 'M', 'pt'],
  ['pf_dora@pt', 'Dora', 'Portugal', 'F', 'pt'], ['pm_alex@pt', 'Alex', 'Portugal', 'M', 'pt'],
  ['pm_santa@pt', 'Santa', 'Portugal', 'M', 'pt'],
];

// Kokoro voices for a language. Once the engine has loaded, voices whose file isn't installed are left out.
function kokoroVoices(lang) {
  const installed = engines.kokoro.installed;
  return KOKORO_TABLE.filter((v) => v[4] === lang && (!installed || installed.has(v[0].split('@')[0]))).map(([id, name, accent, sex]) => ({
    id: `kokoro:${id}`,
    label: `${name} · ${t(accent)} · ${t(sex === 'F' ? 'female' : 'male')}`,
  }));
}

// Distinct, good-quality voices handed out to characters in order, alternating female and male.
const KOKORO_DEFAULTS = {
  en: ['af_heart', 'am_michael', 'af_bella', 'am_fenrir', 'bf_emma', 'bm_george', 'af_nicole', 'am_puck'],
  es: ['ef_dora@es-419', 'em_alex@es-419', 'em_santa@es-419'],
  pt: ['pf_dora', 'pm_alex', 'pm_santa'],
};

// Which language a voice speaks, from its id.
export function voiceLanguage(voiceId = '') {
  const [engine, ...rest] = voiceId.split(':');
  const voice = rest.join(':');
  if (engine === 'kokoro') return KOKORO_TABLE.find((v) => v[0] === voice)?.[4] ?? 'en';
  if (engine === 'piper') return engines.piper.voices.find((v) => v.key === voice.split('#')[0])?.lang ?? voice.slice(0, 2);
  if (engine === 'mac') return engines.mac.voices.find((v) => v.name === voice)?.lang ?? 'en';
  return 'en';
}

export const engines = {
  kokoro: { status: 'loading', message: '', installed: null }, // status: loading | ready | missing | error | off
  mac: { available: Boolean(window.macVoices?.available), voices: [] },
  piper: { voices: [] }, // installed downloads
};

const listeners = new Set();
export function onVoicesChange(fn) {
  listeners.add(fn);
}
const notify = () => listeners.forEach((fn) => fn());

// ---------- Worker plumbing ----------

// A line that takes longer than this is treated as failed, so a stuck engine can't freeze a scene.
const LINE_TIMEOUT_MS = 90_000;
let nextId = 1;

// Runs one request at a time on a worker and survives the worker crashing: pending requests are
// rejected (so callers fall back to another voice) and the next request starts a fresh worker.
function createEngine(url, { onStatus } = {}) {
  let worker = null;
  let queue = Promise.resolve();
  const pending = new Map();

  function failAll(message) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    pending.clear();
  }

  function start() {
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.id && pending.has(data.id)) {
        const { resolve, reject, timer } = pending.get(data.id);
        clearTimeout(timer);
        pending.delete(data.id);
        data.error ? reject(new Error(data.error)) : resolve(data);
      } else {
        onStatus?.(data);
      }
    };
    const crashed = (e) => {
      const message = e?.message || t('The voice engine crashed.');
      worker?.terminate?.();
      worker = null;
      failAll(message);
      onStatus?.({ type: 'crashed', message });
    };
    worker.onerror = crashed;
    worker.onmessageerror = crashed;
    return worker;
  }

  function request(message) {
    const run = () =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(t('The voice took too long to respond.')));
        }, LINE_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        (worker ?? start()).postMessage({ ...message, id });
      });
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  return { start: () => worker ?? start(), request };
}

// ---------- Kokoro ----------

const kokoro = createEngine(new URL('./tts-worker.js', import.meta.url), {
  onStatus(data) {
    if (data.type === 'ready') {
      // If the engine didn't say which voice files it found, assume all of them.
      Object.assign(engines.kokoro, { status: 'ready', installed: data.voices ? new Set(data.voices) : null });
    } else if (data.type === 'missing') {
      engines.kokoro.status = 'missing';
    } else if (data.type === 'error' || data.type === 'crashed') {
      Object.assign(engines.kokoro, { status: 'error', message: data.message });
    } else return;
    notify();
  },
});

function startKokoro() {
  engines.kokoro.status = 'loading';
  kokoro.start().postMessage({ type: 'load' });
}

// On iPhone/iPad, Kokoro (a ~100 MB download, heavy for a phone) is switched on in Settings.
export function setKokoroEnabled(on) {
  settings.kokoroOnDevice = on;
  if (on && engines.kokoro.status === 'off') {
    startKokoro();
    notify();
  }
}

const kokoroGenerate = (text, voice) => kokoro.request({ type: 'generate', text, voice });

// ---------- Piper ----------

const piper = createEngine(new URL('./piper-worker.js', import.meta.url));
const piperGenerate = (text, key, speaker) => piper.request({ text, key, speaker });

export async function refreshPiperVoices() {
  try {
    engines.piper.voices = (await window.piperVoices?.installed()) ?? [];
  } catch {
    engines.piper.voices = [];
  }
  brokenVoices.clear();
  notify();
}

function piperLabel(key) {
  // "en_GB-northern_english_male-medium" -> "Northern English Male · GB · medium"
  const [lang, name, quality] = key.split('-');
  const pretty = name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return `${pretty} · ${lang.split('_')[1]} · ${t(quality)}`;
}

// ---------- Setup ----------

export async function initVoices() {
  if (IS_WEB && !settings.kokoroOnDevice) engines.kokoro.status = 'off';
  else startKokoro();
  refreshPiperVoices();
  if (engines.mac.available) {
    try {
      engines.mac.voices = await window.macVoices.list();
    } catch {
      engines.mac.voices = [];
    }
    notify();
  }
}

export function kokoroUsable() {
  return engines.kokoro.status === 'ready' || engines.kokoro.status === 'loading';
}

// Voices for one language, grouped by engine, for the character voice menus.
export function voiceGroups(lang = 'en') {
  const groups = [];
  if (kokoroUsable()) groups.push({ label: t('Built-in voices (Kokoro)'), voices: kokoroVoices(lang) });
  const piper = engines.piper.voices.filter((v) => v.lang === lang);
  if (piper.length) {
    groups.push({
      label: t('Downloaded voices (Piper)'),
      voices: piper.flatMap((v) =>
        v.speakers.length > 1
          ? v.speakers.map((sp) => ({ id: `piper:${v.key}#${sp.id}`, label: `${piperLabel(v.key)} · ${sp.name}` }))
          : [{ id: `piper:${v.key}`, label: piperLabel(v.key) }],
      ),
    });
  }
  const mac = engines.mac.voices.filter((v) => v.lang === lang);
  if (mac.length) {
    groups.push({
      label: t(DEVICE_VOICES_ARE_LIVE ? 'Device voices' : 'Mac voices'),
      voices: mac.map((v) => {
        const name = v.name.replace(/\s*\((Premium|Enhanced)\)/, '');
        const region = v.locale.split('_')[1];
        return { id: `mac:${v.name}`, label: v.quality === 'standard' ? `${name} · ${region}` : `${name} · ${region} · ${t(v.quality)}` };
      }),
    });
  }
  return groups.filter((g) => g.voices.length);
}

// The voice a character gets by default: Kokoro's picks for the language (by gender when known),
// otherwise whatever is available for that language. `gender` is 'F', 'M' or undefined.
export function defaultVoice(index, lang = 'en', gender) {
  const offered = new Set(voiceGroups(lang).flatMap((g) => g.voices.map((v) => v.id)));
  let picks = (KOKORO_DEFAULTS[lang] ?? KOKORO_DEFAULTS.en).map((id) => `kokoro:${id}`).filter((id) => offered.has(id));
  if (gender) {
    const sameGender = picks.filter((id) => kokoroGender(id) === gender);
    if (sameGender.length) picks = sameGender;
  }
  if (picks.length) return picks[index % picks.length];
  const ids = [...offered];
  return ids.length ? ids[index % ids.length] : null;
}

function kokoroGender(id) {
  return KOKORO_TABLE.find((v) => `kokoro:${v[0]}` === id)?.[3];
}

export function voiceLabel(id, lang) {
  for (const g of voiceGroups(lang ?? voiceLanguage(id))) {
    const v = g.voices.find((x) => x.id === id);
    if (v) return v.label;
  }
  return id ? id.split(':').slice(1).join(':') : t('No voice');
}

// ---------- Generating and playing lines ----------

let ctx = null;
export const audioContext = () => (ctx ??= new AudioContext());
// iOS only lets audio start from a tap; platform-web.js calls this on the first one.
window.__unlockAudio = () => audioContext().resume?.();
const cache = new Map();

// Screenplay punctuation the engines read badly.
function speakable(text) {
  return text
    .replace(/\s*--+\s*/g, '— ')
    .replace(/_/g, '')
    .replace(/^[\s\-–—]+/, '') // a leading dialogue dash isn't spoken
    .replace(/\s+/g, ' ')
    .trim();
}

// Raised for problems the user can act on; the message is already translated.
export class VoiceError extends Error {}

async function synthesize(text, voiceId) {
  const [engine, ...rest] = voiceId.split(':');
  const voice = rest.join(':');
  if (engine === 'kokoro') {
    const { samples, sampleRate } = await kokoroGenerate(text, voice);
    const buffer = audioContext().createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }
  if (engine === 'piper') {
    const [key, speaker] = voice.split('#');
    const { samples, sampleRate } = await piperGenerate(text, key, Number(speaker) || 0);
    const buffer = audioContext().createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }
  if (engine === 'mac' && DEVICE_VOICES_ARE_LIVE) {
    return { live: true, text, voice, duration: 0 }; // spoken when played
  }
  if (engine === 'mac') {
    const wav = await window.macVoices.speak(text, voice);
    if (!wav) throw new Error(t('This Mac voice isn’t available.'));
    return audioContext().decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
  }
  throw new Error(t('Unknown voice {voice}', { voice: voiceId }));
}

// Preferred Mac voice locales for a voice's accent, best first.
function fallbackLocales(voiceId) {
  const [engine, ...rest] = voiceId.split(':');
  const voice = rest.join(':');
  if (engine === 'kokoro') {
    const accent = voice.split('@')[1];
    const lang = voiceLanguage(voiceId);
    if (lang === 'es') return accent === 'es-419' ? ['es_MX', 'es_US', 'es_419', 'es_AR', 'es_CO'] : ['es_ES'];
    if (lang === 'pt') return accent === 'pt' ? ['pt_PT'] : ['pt_BR'];
    return voice.startsWith('b') ? ['en_GB'] : ['en_US'];
  }
  if (engine === 'piper') return [voice.split('-')[0]];
  return [];
}

// A Mac voice in the same language, preferring the same accent. `slot` spreads characters over
// different voices so two partners don't end up sounding identical.
function macFallback(voiceId, slot = 0) {
  const lang = voiceLanguage(voiceId);
  const same = engines.mac.voices.filter((v) => v.lang === lang);
  if (!same.length) return null;
  const preferred = fallbackLocales(voiceId);
  const ordered = [...same].sort((a, b) => {
    const ra = preferred.includes(a.locale) ? 0 : 1;
    const rb = preferred.includes(b.locale) ? 0 : 1;
    return ra - rb;
  });
  const best = ordered.filter((v) => preferred.includes(v.locale));
  const pool = best.length ? best : ordered;
  return pool[slot % pool.length];
}

// Voices that failed this session go straight to their fallback instead of failing again on every line.
const brokenVoices = new Set();

/**
 * Returns { buffer, voiceId }; voiceId differs from the request if a Mac voice had to stand in.
 * `slot` is the character's position among the scene partners (used to pick distinct fallbacks).
 */
export async function getLineAudio(text, voiceId, { slot = 0 } = {}) {
  if (!voiceId) throw new VoiceError(t('No voices for this language on this computer yet. Use “Get more voices…” to download some.'));
  const clean = speakable(text);
  if (!brokenVoices.has(voiceId)) {
    const key = `${voiceId}|${clean}`;
    if (!cache.has(key)) {
      const job = synthesize(clean, voiceId).then((buffer) => ({ buffer, voiceId }));
      cache.set(key, job);
      job.catch(() => cache.delete(key));
    }
    try {
      return await cache.get(key);
    } catch (err) {
      if (voiceId.startsWith('mac:')) throw err;
      console.warn('Voice failed, using a Mac voice instead:', err);
      brokenVoices.add(voiceId);
      const fallback = macFallback(voiceId, slot);
      if (!fallback) throw err;
      return getLineAudio(text, `mac:${fallback.name}`);
    }
  }
  const fallback = macFallback(voiceId, slot);
  if (!fallback) throw new VoiceError(t('This voice isn’t working and no Mac voice in this language is available.'));
  return getLineAudio(text, `mac:${fallback.name}`);
}

let current = null; // { source, finish }

export function stopPlayback() {
  if (current) {
    const { source, finish } = current;
    current = null;
    source.onended = null;
    source.stop();
    finish();
  }
}

// `extraOutput` is an optional audio node that also receives the voice (used to mix it into a recording).
// Live device voices can't be routed there; the microphone picks them up instead.
export function playBuffer(buffer, extraOutput = null) {
  stopPlayback();
  if (buffer?.live) {
    const speech = window.macVoices.play(buffer.text, buffer.voice);
    return new Promise((resolve) => {
      const source = { stop: speech.cancel, onended: null };
      current = { source, finish: resolve };
      speech.done.then(() => {
        if (current?.source === source) current = null;
        resolve();
      });
    });
  }
  const ac = audioContext();
  if (ac.state === 'suspended') ac.resume();
  const source = ac.createBufferSource();
  source.buffer = buffer;
  source.connect(ac.destination);
  if (extraOutput) source.connect(extraOutput);
  return new Promise((resolve) => {
    current = { source, finish: resolve };
    source.onended = () => {
      if (current?.source === source) current = null;
      resolve();
    };
    source.start();
  });
}
