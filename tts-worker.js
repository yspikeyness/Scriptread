// Runs the Kokoro voice engine off the main thread so the interface stays responsive.
import { LOCAL_MODEL, CHECK_FILES } from './offline-fetch.js';
import { KokoroTTS, env } from './vendor/kokoro.web.js';
import { toIpa, splitIntoChunks } from './phonemes.js';

env.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Every voice file the app knows about; the ones actually on disk are reported to the interface.
const VOICE_FILES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova',
  'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis',
  'bf_alice', 'bf_lily', 'bm_daniel', 'bm_fable', 'ef_dora', 'em_alex', 'em_santa', 'pf_dora', 'pm_alex', 'pm_santa',
];

// Kokoro voice names start with a language letter. kokoro-js only handles English itself
// (a = American, b = British), so other languages are phonemized here and fed in directly.
// "ef_dora@es-419" means voice ef_dora with Latin American pronunciation.
const ESPEAK_VOICE = { e: 'es', p: 'pt-br' };

// Short silence between the chunks of a long line, in seconds.
const CHUNK_GAP = 0.12;

let tts = null;
let loading = null;

async function present(file) {
  try {
    return (await fetch(LOCAL_MODEL + file, { method: 'HEAD' })).ok;
  } catch {
    return false;
  }
}

// Loads once; generate requests that arrive while loading wait for it instead of failing.
function load() {
  loading ??= (async () => {
    if (CHECK_FILES && !(await present('onnx/model_quantized.onnx'))) return { type: 'missing' };
    tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' });
    if (!CHECK_FILES) return { type: 'ready' }; // web version: voices download when first used
    const voices = [];
    for (const v of VOICE_FILES) if (await present(`voices/${v}.bin`)) voices.push(v);
    return { type: 'ready', voices };
  })();
  return loading;
}

async function generateChunk(text, voice, espeakVoice, speed) {
  if (!espeakVoice) return tts.generate(text, { voice, speed });
  const ipa = await toIpa(text, espeakVoice);
  const { input_ids } = tts.tokenizer(ipa, { truncation: true });
  return tts.generate_from_ids(input_ids, { voice, speed });
}

// Kokoro can only say about 25 seconds at a time, so long speeches are split at sentence (or clause)
// boundaries, generated piece by piece and joined back together.
async function generate(text, voiceId, speed) {
  const ready = await load();
  if (ready.type !== 'ready') throw new Error('The built-in voices aren’t installed.');
  const [voice, accent] = voiceId.split('@');
  const espeakVoice = accent ?? ESPEAK_VOICE[voice[0]];

  const pieces = [];
  let rate = 24000;
  for (const chunk of splitIntoChunks(text)) {
    const audio = await generateChunk(chunk, voice, espeakVoice, speed);
    rate = audio.sampling_rate;
    pieces.push(audio.audio);
  }
  const gap = Math.round(CHUNK_GAP * rate);
  const total = pieces.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, pieces.length - 1);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const [i, p] of pieces.entries()) {
    samples.set(p, offset);
    offset += p.length + (i < pieces.length - 1 ? gap : 0);
  }
  return { samples, sampleRate: rate };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      self.postMessage(await load());
    } else if (data.type === 'generate') {
      const { samples, sampleRate } = await generate(data.text, data.voice, data.speed ?? 1);
      self.postMessage({ id: data.id, samples, sampleRate }, [samples.buffer]);
    }
  } catch (err) {
    if (data.type === 'load') self.postMessage({ type: 'error', message: err.message || String(err) });
    else self.postMessage({ id: data.id, error: err.message || String(err) });
  }
};
