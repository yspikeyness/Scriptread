// Runs a scene: speaks the other characters' lines and waits for the actor to finish their own.
import { getLineAudio, playBuffer, stopPlayback, audioContext } from './voices.js';
import { settings } from './settings.js';
import { t } from './i18n.js';

// ---------- Hearing the actor ----------

// The room's background level, shared by every meter and kept between scenes. It is only learned
// from moments that sound like silence, so a long speech can't teach the app that talking is "quiet".
let roomFloor = 0.004;

// Level above which the mic counts as "speaking". Sensitivity 1–10; 5 is the default, higher hears quieter speech.
function thresholdFor(floor) {
  const factor = Math.pow(2, (5 - settings.sensitivity) / 2);
  return Math.max(0.012 * factor, floor * (2 + factor));
}

// Speech rises and falls constantly; a fan or air conditioner hums at a steady level. A sound that
// stays steady for most of a second is treated as background and learned quickly.
let steadyLevel = 0;
let steadyMs = 0;

function learnFloor(level, threshold) {
  steadyLevel += (level - steadyLevel) * 0.2;
  steadyMs = Math.abs(level - steadyLevel) < steadyLevel * 0.12 ? steadyMs + 50 : 0;
  if (level < roomFloor) roomFloor += (level - roomFloor) * 0.3; // quieter: follow quickly
  else if (level < threshold) roomFloor += (level - roomFloor) * 0.05; // background: follow within ~1 s
  else if (steadyMs > 800) roomFloor += (level - roomFloor) * 0.03; // a steady hum above the threshold
  else roomFloor += (level - roomFloor) * 0.0015; // speech: adapt very slowly
  roomFloor = Math.max(roomFloor, 0.0005);
}

// Measures mic loudness. Returns null when there is no microphone.
export function createLevelMeter(ctx, stream) {
  const tracks = stream?.getAudioTracks() ?? [];
  if (!tracks.length) return null;
  const source = ctx.createMediaStreamSource(new MediaStream(tracks));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  // Keep the analyser pulled by the audio graph without making the mic audible.
  const silent = ctx.createGain();
  silent.gain.value = 0;
  analyser.connect(silent).connect(ctx.destination);

  const samples = new Float32Array(analyser.fftSize);
  return {
    read() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const level = Math.sqrt(sum / samples.length);
      const threshold = thresholdFor(roomFloor);
      learnFloor(level, threshold);
      return { level, threshold };
    },
    stop() {
      source.disconnect();
      silent.disconnect();
    },
  };
}

// Waits for the actor to speak and then pause for `settings.pauseMs`.
// Returns { done: Promise, finish() }; call finish() to end the wait early (e.g. Space).
export function listenForTurn(meter, { onLevel = () => {}, onSpeaking = () => {} } = {}) {
  const TICK = 50;
  let speechMs = 0;
  let silenceMs = 0;
  let started = false;
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const timer = setInterval(() => {
    const { level, threshold } = meter.read();
    onLevel(level, threshold);
    if (level > threshold) {
      speechMs += TICK;
      silenceMs = 0;
      if (!started && speechMs >= 150) {
        started = true;
        onSpeaking();
      }
    } else {
      silenceMs += TICK;
      if (!started) speechMs = 0;
      if (started && silenceMs >= settings.pauseMs) finish();
    }
  }, TICK);
  function finish() {
    clearInterval(timer);
    resolve();
  }
  return { done, finish };
}

// Resolves after `ms` (Infinity = never), or when finish() is called.
export function holdFor(ms) {
  let finish;
  const done = new Promise((resolve) => {
    const timer = Number.isFinite(ms) ? setTimeout(resolve, ms) : null;
    finish = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { done, finish };
}

// Roughly how long it takes to read a line, so an unvoiced line stays on screen long enough.
const readingTime = (text) => Math.max(1500, text.split(/\s+/).length * 350);

// ---------- Space key ----------

// Space moves on in whatever is currently running (a scene or the slate cues). Targets stack, so when
// one ends the previous one gets Space back. Anything with a next() method can be a target.
const spaceTargets = [];
export function setSpaceTarget(target) {
  spaceTargets.push(target);
}
export function clearSpaceTarget(target) {
  const i = spaceTargets.lastIndexOf(target);
  if (i >= 0) spaceTargets.splice(i, 1);
}

// Only fields you type into keep Space for themselves; sliders, menus and buttons don't.
function isTextEntry(el) {
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number|)$/.test(el.type || '');
}

let spaceHandled = false;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || isTextEntry(e.target) || !spaceTargets.length) return;
  e.preventDefault();
  spaceHandled = true;
  if (e.repeat) return; // holding Space down moves on once, not once per auto-repeat
  spaceTargets[spaceTargets.length - 1].next();
});
// Also swallow the matching keyup, even if the scene ended on that press, so Space can't "click"
// whichever button has focus (e.g. Play, which would restart the scene).
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHandled) {
    e.preventDefault();
    spaceHandled = false;
  }
});

// ---------- Scenes ----------

// Splits the script into scenes at each scene heading. Returns [{ title, start, end }] (end exclusive).
export function listScenes(elements) {
  const scenes = [];
  elements.forEach((el, i) => {
    if (el.type === 'heading') scenes.push({ title: el.text, start: i, end: elements.length });
  });
  if (!scenes.length || scenes[0].start > 0) {
    const hasLeadingLines = elements.slice(0, scenes[0]?.start ?? elements.length).some((e) => e.type === 'dialogue');
    if (hasLeadingLines || !scenes.length) scenes.unshift({ title: t('Start of script'), start: 0, end: elements.length });
  }
  for (let i = 0; i < scenes.length - 1; i++) scenes[i].end = scenes[i + 1].start;
  return scenes.filter((s) => elements.slice(s.start, s.end).some((e) => e.type === 'dialogue'));
}

// A dialogue line with something to say (a cue with only "(nods)" has no words).
export const hasWords = (el) => el.type === 'dialogue' && /[\p{L}\p{N}]/u.test(el.text);

export class SceneRunner {
  /**
   * @param {object} opts
   * @param {object[]} opts.elements   script elements
   * @param {string} opts.userCharacter
   * @param {object} opts.voices       character name -> voice id
   * @param {MediaStream} opts.micStream
   * @param {AudioNode} [opts.extraOutput]  also send partner voices here (for recording)
   * @param {(index:number, state:string) => void} [opts.onUpdate]
   *        state: 'partner' | 'you' | 'listening' | 'novoice' (partner has no voice) | 'failed' (voice failed)
   * @param {(level:number, threshold:number) => void} [opts.onLevel]
   * @param {(reason:'done'|'stopped') => void} [opts.onEnd]
   */
  constructor(opts) {
    Object.assign(this, { extraOutput: null, onUpdate() {}, onLevel() {}, onEnd() {} }, opts);
    this.running = false;
    this.index = -1;
    this.hasMic = false;
    this._skip = null;
  }

  isPartner(el) {
    return el.type === 'dialogue' && el.speaker !== this.userCharacter;
  }

  // Which "seat" a character has, so fallback voices still differ between characters.
  slotOf(speaker) {
    return Math.max(0, Object.keys(this.voices).indexOf(speaker));
  }

  lineAudio(el) {
    return getLineAudio(el.text, this.voices[el.speaker], { slot: this.slotOf(el.speaker) });
  }

  async run(start, end = this.elements.length) {
    this.running = true;
    setSpaceTarget(this);
    const ctx = audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (!this.running) return this._finish('stopped'); // stopped while the audio was waking up
    this._meter = createLevelMeter(ctx, this.micStream);
    this.hasMic = Boolean(this._meter);
    // Keep learning the room's quiet level between turns, not only while the actor talks.
    this._background = this._meter && setInterval(() => this._listening || this._meter.read(), 50);

    // Start generating every partner line now; each is awaited when its turn comes.
    for (let i = start; i < end; i++) {
      const el = this.elements[i];
      if (this.isPartner(el) && hasWords(el) && this.voices[el.speaker]) this.lineAudio(el).catch(() => {});
    }

    for (let i = start; i < end && this.running; i++) {
      const el = this.elements[i];
      if (!hasWords(el)) continue;
      this.index = i;
      if (this.isPartner(el)) await this._partnerLine(i, el);
      else {
        this.onUpdate(i, 'you');
        await this._waitForActor(i);
      }
    }
    this._finish(this.running ? 'done' : 'stopped');
  }

  async _partnerLine(i, el) {
    if (!this.voices[el.speaker]) {
      this.onUpdate(i, 'novoice');
      await this._wait(holdFor(readingTime(el.text)));
      return;
    }
    this.onUpdate(i, 'partner');
    try {
      const { buffer } = await this._skippable(this.lineAudio(el));
      if (buffer && this.running) await this._skippable(playBuffer(buffer, this.extraOutput));
    } catch (err) {
      console.warn('Could not play line', err);
      if (!this.running) return;
      this.onUpdate(i, 'failed');
      await this._wait(holdFor(readingTime(el.text)));
    }
  }

  _finish(reason) {
    clearInterval(this._background);
    this._meter?.stop();
    this._meter = null;
    this.running = false;
    clearSpaceTarget(this);
    this.onEnd(reason);
  }

  // Move on to the next line now (skips a partner line, or ends the actor's turn).
  next() {
    stopPlayback();
    this._skip?.();
  }

  stop() {
    this.running = false;
    this.next();
  }

  _skippable(promise) {
    return Promise.race([promise, new Promise((resolve) => (this._skip = () => resolve({})))]);
  }

  _wait(hold) {
    this._skip = hold.finish;
    return hold.done;
  }

  // Resolves once the actor has spoken and then paused, or when skipped.
  async _waitForActor(index) {
    if (!this._meter) return this._wait(holdFor(Infinity)); // no mic: wait for Space / Next
    this._listening = true;
    const turn = listenForTurn(this._meter, {
      onLevel: this.onLevel,
      onSpeaking: () => this.onUpdate(index, 'listening'),
    });
    await this._wait(turn);
    this._listening = false;
  }
}
