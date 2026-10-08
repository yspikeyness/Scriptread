// iPhone / iPad (web) version: provides, in the browser, what the desktop app gets from its
// main process: device voices, Piper voice downloads, and saving takes. Loaded before the app.
(function () {
  window.appInfo = { platform: 'web' };
  const SUPPORTED = ['en', 'es', 'pt'];

  // ---------- Offline: install the service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline mode unavailable', err));
  }

  // iOS only starts audio and speech from a tap: unlock both on the first one.
  let unlocked = false;
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    window.__unlockAudio?.();
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(' '));
  };
  document.addEventListener('pointerup', unlock, { once: false, capture: true });

  // ---------- Device voices (spoken live by iOS) ----------
  function loadVoices() {
    return new Promise((resolve) => {
      const voices = speechSynthesis.getVoices();
      if (voices.length) return resolve(voices);
      const done = () => resolve(speechSynthesis.getVoices());
      speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 1500);
    });
  }
  let byName = new Map();
  window.macVoices = {
    available: 'speechSynthesis' in window,
    realtime: true,
    async list() {
      const voices = (await loadVoices()).filter((v) => SUPPORTED.includes(v.lang.slice(0, 2).toLowerCase()));
      byName = new Map(voices.map((v) => [v.name, v]));
      const quality = (v) => (/premium/i.test(v.voiceURI + v.name) ? 'premium' : /enhanced/i.test(v.voiceURI + v.name) ? 'enhanced' : 'standard');
      const rank = { premium: 0, enhanced: 1, standard: 2 };
      return [...byName.values()]
        .map((v) => ({ name: v.name, locale: v.lang.replace('-', '_'), lang: v.lang.slice(0, 2).toLowerCase(), quality: quality(v) }))
        .sort((a, b) => rank[a.quality] - rank[b.quality] || a.name.localeCompare(b.name));
    },
    // Speaks now; returns { done: Promise, cancel() }.
    play(text, name) {
      const u = new SpeechSynthesisUtterance(text);
      const voice = byName.get(name);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      let finish;
      const done = new Promise((resolve) => (finish = resolve));
      u.onend = u.onerror = () => finish();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      return {
        done,
        cancel() {
          speechSynthesis.cancel();
          finish();
        },
      };
    },
  };

  // ---------- Piper voices: downloaded into the browser's storage ----------
  const PIPER_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
  const PIPER_CACHE = 'piper-voices';
  const MAX_SPEAKERS = 30;
  const modelUrl = (file) => new URL(`models/piper/${file}`, location.href).href;
  let catalog = null;
  const progressListeners = [];

  function summarize(entry) {
    const files = Object.entries(entry.files || {});
    const model = files.find(([f]) => f.endsWith('.onnx'));
    const speakers = Object.entries(entry.speaker_id_map || {})
      .sort((a, b) => a[1] - b[1])
      .slice(0, MAX_SPEAKERS)
      .map(([name, id]) => ({ name, id }));
    return {
      key: entry.key,
      lang: entry.language?.family,
      name: entry.name,
      region: entry.language?.region,
      country: entry.language?.country_english,
      quality: entry.quality,
      numSpeakers: entry.num_speakers || 1,
      speakers,
      sizeMB: model ? Math.round(model[1].size_bytes / 1e6) : null,
      files: files.map(([f]) => f).filter((f) => f.endsWith('.onnx') || f.endsWith('.onnx.json')),
    };
  }

  async function getCatalog() {
    if (catalog) return catalog;
    const cache = await caches.open(PIPER_CACHE);
    const url = modelUrl('voices.json');
    try {
      const res = await fetch(PIPER_BASE + 'voices.json');
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      await cache.put(url, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
      catalog = data;
    } catch {
      const saved = await cache.match(url);
      if (!saved) throw new Error('PIPER_OFFLINE');
      catalog = await saved.json();
    }
    return catalog;
  }

  window.piperVoices = {
    async catalog() {
      const data = await getCatalog();
      return Object.values(data)
        .filter((v) => SUPPORTED.includes(v.language?.family))
        .map(summarize)
        .sort((a, b) => (a.region || '').localeCompare(b.region || '') || a.name.localeCompare(b.name));
    },
    async installed() {
      const cache = await caches.open(PIPER_CACHE);
      const urls = (await cache.keys()).map((r) => r.url);
      const voices = [];
      for (const url of urls.filter((u) => u.endsWith('.onnx.json'))) {
        const key = decodeURIComponent(url.split('/').pop().slice(0, -'.onnx.json'.length));
        if (!urls.includes(url.slice(0, -'.json'.length))) continue;
        try {
          const config = await (await cache.match(url)).json();
          const speakers = Object.entries(config.speaker_id_map || {})
            .sort((a, b) => a[1] - b[1])
            .slice(0, MAX_SPEAKERS)
            .map(([name, id]) => ({ name, id }));
          voices.push({ key, lang: config.language?.family ?? key.slice(0, 2), region: config.language?.region, quality: config.audio?.quality, speakers });
        } catch {
          // a damaged entry just isn't offered
        }
      }
      return voices;
    },
    async download(key) {
      const entry = (await getCatalog())[key];
      if (!entry) throw new Error('UNKNOWN_VOICE');
      const cache = await caches.open(PIPER_CACHE);
      // Model first, config last: a voice only counts as installed once both are complete.
      const files = summarize(entry).files.sort((a, b) => a.endsWith('.onnx.json') - b.endsWith('.onnx.json'));
      for (const file of files) {
        const res = await fetch(PIPER_BASE + file);
        if (!res.ok) throw new Error(`DOWNLOAD_FAILED:${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total > 1e6) progressListeners.forEach((fn) => fn({ key, received, total }));
        }
        const name = file.split('/').pop();
        const type = name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        await cache.put(modelUrl(name), new Response(new Blob(chunks), { headers: { 'Content-Type': type } }));
      }
    },
    async remove(key) {
      const cache = await caches.open(PIPER_CACHE);
      await cache.delete(modelUrl(`${key}.onnx`));
      await cache.delete(modelUrl(`${key}.onnx.json`));
    },
    onProgress(fn) {
      progressListeners.push(fn);
    },
  };

  // ---------- Saving takes: the share sheet (Save Video / Save to Files) ----------
  window.files = {
    beginTake: async () => null, // takes stay in memory until saved
    async saveTakeBytes(blob, fileName) {
      const file = new File([blob], fileName, { type: blob.type || 'video/mp4' });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: fileName });
          return fileName;
        } catch (err) {
          if (err.name === 'AbortError') return null; // closed the share sheet
          throw err;
        }
      }
      // No share sheet (e.g. a desktop browser): a normal download.
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      return fileName;
    },
  };
})();
