// Piper text-to-speech: turns text into phoneme ids and runs a Piper voice model.
// Works with any ONNX Runtime build passed in as `ort`; `toIpa` comes from phonemes.js.

// Piper's eSpeak voice names → the English phonemizer's names for the same accent.
const ESPEAK_ALIASES = { 'en-gb': 'en' };

export async function textToPhonemeIds(text, config, toIpa) {
  const map = config.phoneme_id_map;
  const voice = ESPEAK_ALIASES[config.espeak?.voice] ?? config.espeak?.voice ?? 'en-us';
  const ipa = await toIpa(text, voice, (mark) => Boolean(map[mark]));

  const ids = [...map['^'], ...map['_']];
  for (const ch of ipa) {
    if (!map[ch]) continue;
    ids.push(...map[ch], ...map['_']);
  }
  ids.push(...map['$']);
  return ids;
}

export async function synthesize(ort, session, config, text, toIpa, speakerId = 0, speed = 1) {
  const ids = await textToPhonemeIds(text, config, toIpa);
  const inf = config.inference ?? {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor(
      'float32',
      Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / speed, inf.noise_w ?? 0.8]),
      [3],
    ),
  };
  if (session.inputNames.includes('sid')) {
    feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speakerId)]), [1]);
  }
  const out = await session.run(feeds);
  const samples = out[session.outputNames[0]].data;
  return { samples: Float32Array.from(samples), sampleRate: config.audio?.sample_rate ?? 22050 };
}
