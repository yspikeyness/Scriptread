// Text → IPA phonemes for the voice engines, in every supported language.
// English uses the small English-only phonemizer; Spanish and Portuguese use the full eSpeak-NG build.
import { phonemize as phonemizeEnglish } from './vendor/phonemizer.js';
import ESpeakNG from './vendor/espeak/espeak-ng.js';

let compiled = null;

// Compile the 18 MB engine once per worker; each call then only needs a quick fresh instance.
async function espeakModule() {
  compiled ??= WebAssembly.compileStreaming(fetch(new URL('./vendor/espeak/espeak-ng.wasm', import.meta.url)));
  compiled.catch(() => (compiled = null)); // let a later call retry
  return compiled;
}

// Returns one IPA string per clause, like the English phonemizer does.
async function phonemizeEspeak(text, voice) {
  const module = await espeakModule();
  // eSpeak takes the text as a command-line argument, so it must not start with "-".
  const safe = text.replace(/^[\s\-–—]+/, '');
  if (!safe) return [];
  const es = await ESpeakNG({
    arguments: ['-q', '-b', '1', '--ipa', '-v', voice, '--phonout', 'out', safe],
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports)
        .then((instance) => done(instance, module))
        .catch((err) => console.error('eSpeak failed to start', err));
      return {};
    },
    print() {},
    printErr() {},
  });
  return es.FS.readFile('out', { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
}

export function phonemizeClauses(text, voice) {
  return voice.startsWith('en') ? phonemizeEnglish(text, voice) : phonemizeEspeak(text, voice);
}

// Titles after which a full stop isn't the end of a sentence.
const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|Drs|St|Jr|Sr|Sra|Srta|Dra|Prof|Profa|Lic|Ing|Sto|Sta|vs|etc|Av|Vd|Ud|Uds)\.$/i;

// Splits text at pause marks: a run of punctuation followed by a space or the end of the text.
// Marks inside numbers ("1.500", "3,5", "5:30") and after titles ("Dr. Silva") don't split.
// Returns [{ text, mark }] where mark is the pause after the text ('' for none).
function splitAtPauses(text) {
  const out = [];
  let buf = '';
  const re = /([.,!?;:…—]+)(\s+|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index);
    const candidate = buf + before + m[1];
    if (m[1] === '.' && ABBREVIATIONS.test(candidate)) {
      buf = candidate + m[2];
    } else {
      out.push({ text: buf + before, mark: m[1] });
      buf = '';
    }
    last = re.lastIndex;
  }
  const rest = buf + text.slice(last);
  if (rest.trim()) out.push({ text: rest, mark: '' });
  return out;
}

// The single mark that best represents a run like "..?" for intonation. Ellipses and dashes count
// as a pause ("." or ",") since the voices only know a few marks.
function markFor(run) {
  for (const c of ['?', '!']) if (run.includes(c)) return c;
  if (run.includes('.') || run.includes('…')) return '.';
  if (run.includes(';')) return ';';
  if (run.includes(':')) return ':';
  return ',';
}

// Phonemizers drop punctuation, but the voices use it for pauses and intonation, so phonemize the
// text between pause marks and put the marks back. `allowed(mark)` says which marks the voice knows.
export async function toIpa(text, voice, allowed = () => true) {
  // Spanish opening marks and quotes carry no sound of their own.
  const clean = text.replace(/[¿¡«»“”"]/g, '').replace(/^[\s\-–—.,…]+/, '');
  let ipa = '';
  for (const { text: piece, mark } of splitAtPauses(clean)) {
    if (piece.trim()) ipa += (await phonemizeClauses(piece, voice)).join(' ');
    if (mark && ipa) {
      const m = markFor(mark);
      ipa = ipa.trimEnd() + (allowed(m) ? m : allowed(',') ? ',' : '');
    }
    ipa += ' ';
  }
  return ipa.trim();
}

// Splits a long speech into chunks short enough for one pass of the voice engine (Kokoro manages
// about 25 seconds), breaking at sentence ends, then clauses, then words.
export function splitIntoChunks(text, max = 220) {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]+["”»)]*\s*|[^.!?…]+$/g) ?? [text];
  const chunks = [];
  let current = '';
  const push = (s) => {
    if ((current + s).length > max && current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
    current += s;
  };
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      push(sentence);
      continue;
    }
    for (const clause of sentence.match(/[^,;:—]+[,;:—]*\s*/g) ?? [sentence]) {
      if (clause.length <= max) {
        push(clause);
        continue;
      }
      for (const word of clause.split(/(?<=\s)/)) push(word);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
