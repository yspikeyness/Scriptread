// Runs downloaded Piper voices off the main thread.
import * as ort from './vendor/ort-wasm/ort.wasm.min.mjs';
import { toIpa } from './phonemes.js';
import { synthesize } from './piper-core.js';

ort.env.wasm.wasmPaths = new URL('./vendor/ort-wasm/', import.meta.url).href;

const MODELS = new URL('./models/piper/', import.meta.url).href;
const loaded = new Map(); // voice key -> Promise<{ session, config }>

function load(key) {
  if (!loaded.has(key)) {
    const job = (async () => {
      const config = await (await fetch(`${MODELS}${key}.onnx.json`)).json();
      const model = await (await fetch(`${MODELS}${key}.onnx`)).arrayBuffer();
      const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
      return { session, config };
    })();
    loaded.set(key, job);
    job.catch(() => loaded.delete(key));
  }
  return loaded.get(key);
}

self.onmessage = async ({ data }) => {
  try {
    const { session, config } = await load(data.key);
    const { samples, sampleRate } = await synthesize(ort, session, config, data.text, toIpa, data.speaker ?? 0);
    self.postMessage({ id: data.id, samples, sampleRate }, [samples.buffer]);
  } catch (err) {
    self.postMessage({ id: data.id, error: err.message || String(err) });
  }
};
