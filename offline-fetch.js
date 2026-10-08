// iPhone / iPad (web) version of offline-fetch.js. The Kokoro model isn't part of the website (it's
// too big to upload); it's downloaded from its free source the first time and kept by the offline
// service worker, so after that it works without internet.
export const LOCAL_MODEL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';
// Files aren't on disk to check; voices download when first used.
export const CHECK_FILES = false;

const realFetch = self.fetch.bind(self);

self.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  // Fail loudly on a missing file; otherwise the libraries would treat an error page as voice data.
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(LOCAL_MODEL) && !res.ok) throw new Error(`Couldn't download voice file (${res.status})`);
  return res;
};

// The service worker keeps one copy of each model file; stop the libraries keeping a second.
if (self.caches) {
  const open = self.caches.open.bind(self.caches);
  self.caches.open = (name) =>
    name === 'transformers-cache' || name === 'kokoro-voices' ? Promise.reject(new Error('Caching disabled')) : open(name);
}
