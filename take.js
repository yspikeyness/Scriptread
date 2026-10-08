// Records one take into a preview area and offers Save / Discard. Used by the Record and Slate tabs.
// While recording, the video is written to a temporary file in pieces, so even long 4K takes don't
// have to fit in memory when they're saved.
import { settings, saveSettings, QUALITIES, buildFileName } from './settings.js';
import { t, setText, setErrorText, onLanguageChange } from './i18n.js';
import { getStream } from './media.js';
import { script } from './script-ui.js';

const MP4 = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
const WEBM = ['video/webm;codecs=vp9,opus', 'video/webm'];

// ---------- Shared recording state ----------

const recorders = new Set();
const recordingListeners = new Set();

// True while any tab is recording, so anything that would restart the camera can be held off.
export const isAnyRecording = () => [...recorders].some((r) => r.state === 'recording' || r.state === 'stopping');

// Called whenever a recording starts or stops in any tab.
export function onRecordingChange(fn) {
  recordingListeners.add(fn);
}
const notifyRecording = () => recordingListeners.forEach((fn) => fn());

// Take numbers per script, role and clip ("Scene1", "Slate"…), remembered between launches.
function takeKey(clip) {
  return [script.fileName, script.userCharacter ?? '', clip].join('|');
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function slateName() {
  return settings.slate?.find((i) => i.id === 'name')?.value?.trim() ?? '';
}

export class TakeRecorder {
  /**
   * @param {object} els  preview, playback, recordBtn, badge, timer, recordControls, reviewControls,
   *                      saveBtn, discardBtn, note
   * @param {object} hooks
   *   prepare()      -> { stream?, cleanup? }  stream to record (defaults to camera + mic)
   *   started()      called once recording has begun
   *   stopped()      called when recording stops (by the user or by itself)
   *   clip()         -> "Scene1" / "Slate" for the file name
   *   reviewing(isReviewing)  called when playback of a finished take is shown / hidden
   *   setStatus(key, vars, isError)
   *   lockWhileBusy  elements to disable while recording
   */
  constructor(els, hooks) {
    this.els = els;
    this.hooks = hooks;
    this.state = 'idle'; // idle | recording | stopping | review
    this.recorder = null;
    this.blob = null;
    this.url = null;
    this.takeId = null;
    this.saved = false;
    recorders.add(this);
    // The buttons' English labels, translated whenever they're shown (see i18n.js).
    this.recordLabelKey = els.recordBtn.dataset.i18nKey ?? els.recordBtn.textContent;
    this.saveLabelKey = els.saveBtn.dataset.i18nKey ?? els.saveBtn.textContent;
    onLanguageChange(() => this.updateButtons());
    onRecordingChange(() => this.updateButtons());
    els.recordBtn.addEventListener('click', () => (this.state === 'recording' ? this.stop() : this.start()));
    els.saveBtn.addEventListener('click', () => this.save());
    els.discardBtn.addEventListener('click', () => this.reset());
  }

  isRecording() {
    return this.state === 'recording' || this.state === 'stopping';
  }

  attachPreview() {
    this.els.preview.srcObject = getStream();
  }

  // Record/Stop label, and disabled while stopping or while another tab is recording.
  updateButtons() {
    const { recordBtn, saveBtn } = this.els;
    recordBtn.textContent = this.isRecording() ? t('■ Stop') : t(this.recordLabelKey);
    recordBtn.classList.toggle('recording', this.isRecording());
    recordBtn.disabled = this.state === 'stopping' || (this.state === 'idle' && isAnyRecording());
    saveBtn.textContent = this.saved ? t('✓ Saved') : t(this.saveLabelKey);
  }

  lock(locked) {
    for (const el of this.hooks.lockWhileBusy ?? []) el.disabled = locked;
  }

  async start() {
    if (this.state !== 'idle' || isAnyRecording()) return;
    const camera = getStream();
    if (!camera?.getVideoTracks().length) {
      this.hooks.setStatus('No camera available. Check the camera choice in Settings.', null, true);
      return;
    }
    let prepared;
    try {
      prepared = this.hooks.prepare?.() ?? {};
    } catch (err) {
      console.error(err);
      this.hooks.setStatus('Couldn’t start recording: {message}', { message: err.message }, true);
      return;
    }
    const recordStream = prepared.stream ?? camera;
    this.cleanup = prepared.cleanup ?? null;

    const preferred = settings.format === 'webm' ? [...WEBM, ...MP4] : [...MP4, ...WEBM];
    const mimeType = preferred.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const bitrate = (QUALITIES[settings.quality] ?? QUALITIES[1080]).bitrate;
    const ext = mimeType.startsWith('video/webm') ? 'webm' : 'mp4';

    this.state = 'recording';
    notifyRecording();
    try {
      this.takeId = (await window.files?.beginTake(ext)) ?? null;
      this.recorder = new MediaRecorder(recordStream, { mimeType, videoBitsPerSecond: bitrate });
    } catch (err) {
      this.state = 'idle';
      this.cleanup?.();
      notifyRecording();
      this.hooks.setStatus('Couldn’t start recording: {message}', { message: err.message }, true);
      return;
    }

    // Keep the pieces for playback, and write them to the temporary file in order.
    const chunks = [];
    this.writes = Promise.resolve();
    this.writeError = null;
    this.recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      if (this.takeId) {
        const id = this.takeId;
        this.writes = this.writes
          .then(async () => window.files.writeTake(id, new Uint8Array(await e.data.arrayBuffer())))
          .catch((err) => (this.writeError = err));
      }
    };
    const mime = this.recorder.mimeType || mimeType;
    // Clean up here rather than in stop(): the recorder can also end by itself (e.g. the camera
    // is unplugged), and stop() returns before the last piece of video arrives.
    this.recorder.onstop = () => this.finish(new Blob(chunks, { type: mime }));
    this.recorder.onerror = (e) => {
      console.error('Recording error', e.error);
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    };
    this.recorder.start(1000);

    const startedAt = Date.now();
    this.els.timer.textContent = '00:00';
    this.timerId = setInterval(() => (this.els.timer.textContent = formatTime(Date.now() - startedAt)), 250);
    this.els.badge.hidden = false;
    this.lock(true);
    this.updateButtons();
    this.hooks.setStatus('Recording…');
    document.activeElement?.blur(); // so Space can't "click" the focused button
    this.hooks.started?.();
  }

  stop() {
    // Ignore a second click while the take is closing, or before the recorder has actually started.
    if (this.state !== 'recording' || !this.recorder) return;
    this.state = 'stopping';
    this.updateButtons();
    this.recorder.stop();
  }

  async finish(blob) {
    clearInterval(this.timerId);
    this.cleanup?.();
    this.cleanup = null;
    this.els.badge.hidden = true;
    this.hooks.stopped?.();
    this.state = 'review';
    this.lock(false);
    notifyRecording();
    this.updateButtons();
    await this.writes;
    if (this.takeId) await window.files.endTake(this.takeId).catch(() => {});
    this.review(blob);
  }

  review(blob) {
    this.blob = blob;
    this.saved = false;
    this.url = URL.createObjectURL(blob);
    const { preview, playback, recordControls, reviewControls, note, saveBtn } = this.els;
    playback.src = this.url;
    playback.hidden = false;
    preview.hidden = true;
    recordControls.hidden = true;
    reviewControls.hidden = false;
    saveBtn.disabled = false;
    this.updateButtons();
    setText(note, 'Saves as {format}.', { format: blob.type.startsWith('video/mp4') ? 'MP4' : 'WebM' });
    this.hooks.setStatus('Review your take');
    this.hooks.reviewing?.(true);
  }

  reset() {
    if (this.url) URL.revokeObjectURL(this.url);
    if (this.takeId && !this.saved) window.files.discardTake(this.takeId).catch(() => {});
    this.blob = this.url = this.takeId = null;
    this.saved = false;
    this.state = 'idle';
    const { preview, playback, recordControls, reviewControls, note } = this.els;
    playback.removeAttribute('src');
    playback.hidden = true;
    preview.hidden = false;
    reviewControls.hidden = true;
    recordControls.hidden = false;
    setText(note, null);
    this.updateButtons();
    this.hooks.setStatus('Ready');
    this.hooks.reviewing?.(false); // lets the tab show a fuller status (e.g. with the resolution)
  }

  fileName() {
    const clip = this.hooks.clip?.() ?? '';
    const take = (settings.takeCounts[takeKey(clip)] ?? 0) + 1;
    const ext = this.blob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const base = buildFileName(settings.fileTemplate, {
      name: slateName(),
      role: script.userCharacter ?? '',
      project: script.fileName.replace(/\.[^.]+$/, ''),
      clip,
      take,
    });
    return { name: `${base}.${ext}`, clip, take };
  }

  async save() {
    if (this.saved) return;
    const { name, clip, take } = this.fileName();
    const { saveBtn, note } = this.els;
    saveBtn.disabled = true;
    try {
      if (this.writeError) throw this.writeError;
      let savedPath;
      if (this.takeId) {
        savedPath = await window.files.saveTake(this.takeId, name, settings.saveFolder);
      } else {
        // No temporary file (shouldn't happen in the app); fall back to sending the video directly.
        savedPath = await window.files.saveTakeBytes(this.blob, name, settings.saveFolder);
      }
      if (!savedPath) {
        saveBtn.disabled = false; // cancelled
        return;
      }
      this.saved = true;
      settings.takeCounts[takeKey(clip)] = take;
      saveSettings();
      this.updateButtons();
      setText(note, null);
      const done = document.createElement('span');
      done.textContent = t('Saved: {file}', { file: savedPath.split(/[\\/]/).pop() }) + ' ';
      const show = document.createElement('button');
      show.className = 'link';
      show.textContent = t('Show file');
      show.addEventListener('click', () => window.files.showInFolder(savedPath));
      if (window.files.showInFolder) note.append(done, show);
      else note.append(done);
    } catch (err) {
      saveBtn.disabled = false;
      setErrorText(note, err, 'Couldn’t save: {message}');
    }
  }
}
