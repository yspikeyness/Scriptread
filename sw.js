// Offline support for the iPhone / iPad version. The app's own files are stored when it's first
// opened; voice files (Kokoro, Piper) are stored the first time they're downloaded.
const VERSION = '0.9.0-2';
const SHELL_CACHE = `shell-${VERSION}`;
const MODEL_CACHE = 'voice-models';
const SHELL = [
  "./",
  "i18n-es.js",
  "i18n-pt.js",
  "i18n.js",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "index.html",
  "manifest.webmanifest",
  "media.js",
  "offline-fetch.js",
  "phonemes.js",
  "piper-core.js",
  "piper-worker.js",
  "platform-web.js",
  "recorder.js",
  "rehearse-ui.js",
  "scene.js",
  "script-follow.js",
  "script-parser.js",
  "script-ui.js",
  "settings-ui.js",
  "settings.js",
  "slate-ui.js",
  "style.css",
  "take.js",
  "tts-worker.js",
  "vendor/espeak/espeak-ng.js",
  "vendor/espeak/espeak-ng.wasm",
  "vendor/kokoro.web.js",
  "vendor/mammoth.browser.min.js",
  "vendor/ort/ort-wasm-simd-threaded.jsep.mjs",
  "vendor/ort/ort-wasm-simd-threaded.jsep.wasm",
  "vendor/ort-wasm/ort-wasm-simd-threaded.mjs",
  "vendor/ort-wasm/ort-wasm-simd-threaded.wasm",
  "vendor/ort-wasm/ort.wasm.min.mjs",
  "vendor/pdf.min.mjs",
  "vendor/pdf.worker.min.mjs",
  "vendor/phonemizer.js",
  "version.js",
  "voice-library.js",
  "voices.js"
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('shell-') && n !== SHELL_CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// A stored copy without redirect information, so it can be served for any later request.
async function storable(res) {
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Voice model files from huggingface.co: keep the first download, then serve it offline.
  if (url.hostname.endsWith('huggingface.co') && url.pathname.includes('/resolve/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(MODEL_CACHE);
        const hit = await cache.match(request.url);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok && !url.pathname.endsWith('voices.json')) await cache.put(request.url, await storable(res.clone()));
        return res;
      })(),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  // The app itself (and downloaded Piper voices): stored copy first, network as a fallback.
  event.respondWith(
    (async () => {
      const hit = await caches.match(request, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(request);
      } catch {
        if (request.mode === 'navigate') return caches.match('index.html');
        throw new Error('Offline');
      }
    })(),
  );
});
