// Turns screenplay text into a list of elements:
//   { type: 'heading', text }
//   { type: 'action', text }
//   { type: 'dialogue', speaker, ext, text, parts: [{ kind: 'paren'|'speech', text }], dual? }
// `text` on dialogue is only the spoken words; parentheticals live in `parts`.

// Patterns cover English, Spanish and Portuguese screenplays.
const CUE_EXTENSIONS = /(\s*\([^)]*\))+\s*$/; // (CONT'D), (V.O.), (O.S.), (CONT.), (EN OFF), (CONTINUA) ...
// Uppercase in any alphabet, so JOSÉ, MUÑOZ and CONCEIÇÃO count as character names.
const CUE_CHARS = /^[\p{Lu}0-9][\p{Lu}0-9 .'’\-&#]*$/u;
// Name prefixes written in mixed case inside an all-caps cue: McCOY, MacDONALD, DeMARCO, LaFLEUR.
const NAME_PREFIXES = /(^|[\s'’-])(Mc|Mac|De|Di|Da|Du|La|Le|Van|Von|St)(?=\p{Lu})/gu;
// Scene headings: INT. / EXT. / INT./EXT. / I/E, also spelled out (INTERIOR), optionally after a scene number
// ("12 INT. CASA - DÍA", "ESC. 3 - INT."), or Spanish/Portuguese "ESCENA 3" / "CENA 3". Headings are written
// in capitals, so a sentence like "Exterior lights flick on." is not one.
const HEADING = /^(\d+[A-Z]?[.\s]+)?((ESC\.?|ESCENA|CENA)\s*\d+\s*[-–.:]?\s*)?((INT|EXT)(ERIOR)?\.?(\s*[/-]\s*(INT|EXT)(ERIOR)?\.?)?|I\/E)([.\s\-–]|$)|^(ESCENA|CENA)\s+\d+/u;
// Transitions (CUT TO:, CORTE A:, CORTA PARA:, FADE OUT., FUNDIDO A NEGRO) aren't characters.
const TRANSITION = /(:$|^(FADE|FUNDIDO|FUNDE|CORTE|CORTA|CUT|DISSOLVE|ENCADENADO|SMASH|MATCH)\b)/u;
// All-caps lines that are directions, not character names.
const NOT_CHARACTERS = new Set([
  'MOMENTS LATER', 'LATER', 'CONTINUOUS', 'BACK TO SCENE', 'THE END', 'END', 'BEAT', 'SILENCE', 'BLACK', 'BLACKOUT',
  'INTERCUT', 'FLASHBACK', 'END FLASHBACK', 'MONTAGE', 'END MONTAGE', 'SERIES OF SHOTS', 'TITLE', 'SUPER', 'OVER BLACK',
  'MÁS TARDE', 'MOMENTOS DESPUÉS', 'MOMENTOS DESPUES', 'CONTINÚA', 'CONTINUA', 'FIN', 'SILENCIO', 'NEGRO',
  'MAIS TARDE', 'MOMENTOS DEPOIS', 'DE VOLTA À CENA', 'FIM', 'SILÊNCIO', 'PRETO', 'SELF-TAPE INSTRUCTIONS',
]);
// Page furniture: "(MORE)", "CONTINUED:", and revision asterisks in the margin.
const PAGE_NOISE =
  /^(\*+|\((MORE|MÁS|MAS|MAIS|SIGUE|CONTINÚA|CONTINUA)\)|\(?(CONTINUED|CONTINUACIÓN|CONTINUAÇÃO|CONTINÚA|CONTINUA)\)?:?|(CONTINUED|CONTINUACIÓN|CONTINUAÇÃO):.*|\(CONT['’]D\)|\(CONT\.?\))$/iu;
// Page and scene numbers ("12.", "3A"). Kept when they sit where dialogue goes ("1972." can be a line).
const NUMBER_ONLY = /^\d+[A-Z]?\.?$/;

// Curly and straight apostrophes are the same character name (O'BRIEN = O’BRIEN).
const normalizeName = (name) => name.replace(/’/g, "'").replace(/\s+/g, ' ').trim();

function splitCue(text) {
  const match = text.match(CUE_EXTENSIONS);
  const name = normalizeName(match ? text.slice(0, match.index) : text);
  const ext = match ? match[0].trim() : '';
  return { name, ext };
}

export function isCueText(text) {
  const { name } = splitCue(text.trim());
  if (!name || name.length > 35 || !/\p{Lu}/u.test(name)) return false;
  const upper = name.replace(NAME_PREFIXES, (m) => m.toUpperCase());
  if (HEADING.test(upper) || TRANSITION.test(upper)) return false;
  // Cue names don't end like sentences ("SILENCE.", "BANG!").
  if (/[.!?]$/.test(upper) && !/\b(JR|SR|DR|MR|MRS|MS|ST)\.$/.test(upper)) return false;
  if (NOT_CHARACTERS.has(upper.replace(/[.:]+$/, ''))) return false;
  return CUE_CHARS.test(upper);
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount) [best, bestCount] = [v, c];
  return best;
}

function makeDialogue(cueText) {
  const { name, ext } = splitCue(cueText.trim());
  return { type: 'dialogue', speaker: name, ext, text: '', parts: [] };
}

function addPart(dialogue, kind, text) {
  const last = dialogue.parts[dialogue.parts.length - 1];
  if (last && last.kind === kind) last.text += ' ' + text;
  else dialogue.parts.push({ kind, text });
}

// Adds one line of a speech, splitting "(to Bob) Look." into the parenthetical and the words.
// Returns whether a parenthetical is still open at the end of the line.
function addLine(dialogue, text, inParen) {
  let rest = text;
  if (!inParen && rest.startsWith('(')) inParen = true;
  if (inParen) {
    const close = rest.indexOf(')');
    if (close < 0) {
      addPart(dialogue, 'paren', rest);
      return true;
    }
    addPart(dialogue, 'paren', rest.slice(0, close + 1));
    rest = rest.slice(close + 1).trim();
    inParen = false;
  }
  if (rest) {
    if (rest.startsWith('(')) return addLine(dialogue, rest, false);
    addPart(dialogue, 'speech', rest);
  }
  return inParen;
}

function finalize(elements) {
  const out = [];
  for (const el of elements) {
    if (el.type === 'dialogue') {
      el.text = el.parts.filter((p) => p.kind === 'speech').map((p) => p.text).join(' ');
      // A speech split by a page break shows up as two blocks for the same speaker; rejoin it.
      const prev = out[out.length - 1];
      if (prev && prev.type === 'dialogue' && prev.speaker === el.speaker && el.pageBreakBefore && !el.dual && !prev.dual) {
        prev.parts.push(...el.parts);
        prev.text = [prev.text, el.text].filter(Boolean).join(' ');
        continue;
      }
    }
    delete el.pageBreakBefore;
    out.push(el);
  }
  out.forEach((el, i) => (el.id = i));
  return out;
}

// ---------- PDF (uses the position of each line on the page) ----------

// Lines are split into separate pieces when there's a wide gap between words on the same row,
// so side-by-side (dual) dialogue stays in two columns.
const COLUMN_GAP = 40;

export async function extractPdfLines(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const rows = [];
    for (const it of items) {
      if (!it.str) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) rows.push((row = { y, items: [] }));
      // Some PDFs store side-by-side text as one string padded with spaces ("BOB        CAROL");
      // split it at long runs of spaces, estimating each piece's position from the character width.
      const charWidth = it.str.length ? it.width / it.str.length : 0;
      const re = /\S+(?:\s{1,3}\S+)*/g;
      let m;
      while ((m = re.exec(it.str))) {
        row.items.push({ x: x + m.index * charWidth, w: m[0].length * charWidth, str: m[0] });
      }
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let text = '';
      let startX = null;
      let end = null;
      const flush = () => {
        const clean = text.replace(/\s+/g, ' ').trim();
        if (clean) lines.push({ page: p, x: startX, y: row.y, text: clean });
        text = '';
        startX = null;
      };
      for (const it of row.items) {
        if (!it.str.trim() && startX === null) continue;
        if (end !== null && it.x > end + COLUMN_GAP && text.trim()) flush();
        if (startX === null) startX = it.x;
        if (end !== null && it.x > end + 1 && !text.endsWith(' ') && !it.str.startsWith(' ') && text) text += ' ';
        text += it.str;
        end = it.x + it.w;
      }
      flush();
    }
  }
  return lines;
}

// Text that repeats at the same height on several pages (title, revision date, "SIDES" …) is a
// running header or footer, not part of the scene.
function findRunningHeaders(lines) {
  const pages = new Set(lines.map((l) => l.page));
  if (pages.size < 2) return new Set();
  const seen = new Map();
  for (const l of lines) {
    const key = `${Math.round(l.y / 4)}|${l.text.replace(/\d+/g, '#')}`;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(l.page);
  }
  const repeated = new Set();
  for (const l of lines) {
    const key = `${Math.round(l.y / 4)}|${l.text.replace(/\d+/g, '#')}`;
    if (seen.get(key).size >= 2 && !isCueText(l.text)) repeated.add(l);
  }
  return repeated;
}

export function parsePositionedLines(rawLines) {
  const headers = findRunningHeaders(rawLines);
  const candidates = rawLines.filter((l) => !PAGE_NOISE.test(l.text) && !headers.has(l));
  // First pass without number-only lines to learn the layout.
  let lines = candidates.filter((l) => !NUMBER_ONLY.test(l.text));

  const lineHeightOf = (ls) => {
    const gaps = [];
    for (let i = 1; i < ls.length; i++) {
      if (ls[i].page === ls[i - 1].page && ls[i].y !== ls[i - 1].y) gaps.push(Math.round(ls[i - 1].y - ls[i].y));
    }
    // Normal line spacing is the tightest regular gap; the gap between speeches is roughly double, and in
    // short sides with mostly one-line speeches it can be the most common gap, so don't just take the mode.
    const positive = gaps.filter((g) => g > 0);
    if (!positive.length) return 12;
    const tightest = Math.min(...positive);
    return mode(positive.filter((g) => g <= tightest * 1.3)) || 12;
  };
  const lineHeight = lineHeightOf(lines);
  const sameBlock = (a, b) => a.page === b.page && a.y - b.y <= lineHeight * 1.5 && a.y - b.y >= 0;
  const sameRow = (a, b) => a && b && a.page === b.page && Math.abs(a.y - b.y) < 1;

  // Learn this script's dialogue indent from the line that follows each candidate cue.
  const nextDialogueX = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const next = lines[i + 1];
    if (isCueText(lines[i].text) && !sameRow(lines[i], next) && sameBlock(lines[i], next) && next.x < lines[i].x - 20 && !next.text.startsWith('(')) {
      nextDialogueX.push(Math.round(next.x / 4) * 4);
    }
  }
  const dialogueX = mode(nextDialogueX);
  if (dialogueX === null) return [];

  // Second pass: keep number-only lines that sit in the dialogue column.
  lines = candidates.filter((l) => !NUMBER_ONLY.test(l.text) || Math.abs(l.x - dialogueX) <= 12);

  // The line after `i` that isn't on the same row (dual dialogue has two pieces per row).
  const nextRowStart = (i) => {
    let j = i + 1;
    while (j < lines.length && sameRow(lines[i], lines[j])) j++;
    return j;
  };

  const isCueAt = (i) => {
    const line = lines[i];
    const next = lines[nextRowStart(i)];
    return (
      next &&
      isCueText(line.text) &&
      line.x > dialogueX + 20 &&
      sameBlock(line, next) &&
      next.x >= dialogueX - 12 &&
      next.x < line.x
    );
  };

  // Two character names side by side start a dual-dialogue block.
  const isDualAt = (i) => {
    const a = lines[i];
    const b = lines[i + 1];
    return sameRow(a, b) && isCueText(a.text) && isCueText(b.text) && !sameRow(a, lines[i + 2]) && b.x - a.x > 100;
  };

  // Skip leading pages (cover sheets, taping instructions) that contain no dialogue.
  let start = lines.findIndex((_, i) => isCueAt(i) || isDualAt(i));
  if (start < 0) return []; // doesn't look like a screenplay layout; the caller falls back to plain text
  const firstPage = lines[start].page;
  start = lines.findIndex((l) => l.page === firstPage);

  const elements = [];
  let action = null;
  let lastDialogueLine = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (isDualAt(i)) {
      // Split the following rows into the left and right speeches at the right-hand name's indent.
      action = null;
      // Dialogue is indented left of each name, so split halfway between the two names.
      const split = (line.x + lines[i + 1].x) / 2;
      const left = makeDialogue(line.text);
      const right = makeDialogue(lines[i + 1].text);
      left.dual = right.dual = true;
      let parens = [false, false];
      let j = i + 2;
      let prev = lines[i];
      while (j < lines.length && sameBlock(prev, lines[j])) {
        const piece = lines[j];
        const side = piece.x < split ? 0 : 1;
        parens[side] = addLine(side ? right : left, piece.text, parens[side]);
        prev = piece;
        j++;
      }
      elements.push(left, right);
      i = j - 1;
      continue;
    }
    if (isCueAt(i)) {
      action = null;
      const dialogue = makeDialogue(line.text);
      // Continuation of a speech from the previous page? Only page furniture may lie between: a line
      // or two at the very top of the new page (title, revision date) above the cue.
      if (lastDialogueLine && lastDialogueLine.page !== line.page) {
        const between = lines.slice(lines.indexOf(lastDialogueLine) + 1, i);
        const furniture =
          between.length <= 2 &&
          between.every((l) => l.page === line.page && l.y > line.y + lineHeight * 1.5 && !HEADING.test(l.text));
        if (furniture) {
          dialogue.pageBreakBefore = true;
          elements.splice(elements.length - between.length, between.length); // drop the header lines
        }
      }
      let inParen = false;
      while (i + 1 < lines.length && sameBlock(lines[i], lines[i + 1]) && lines[i + 1].x >= dialogueX - 12) {
        inParen = addLine(dialogue, lines[++i].text, inParen);
      }
      elements.push(dialogue);
      lastDialogueLine = lines[i];
    } else if (HEADING.test(line.text)) {
      action = null;
      lastDialogueLine = null;
      elements.push({ type: 'heading', text: line.text });
    } else if (action && sameBlock(lines[i - 1], line)) {
      action.text += ' ' + line.text;
    } else {
      action = { type: 'action', text: line.text };
      elements.push(action);
    }
  }
  return finalize(elements);
}

// ---------- Word / plain text (no positions, just paragraphs) ----------

export function parseParagraphs(rawParagraphs) {
  const paras = rawParagraphs.map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => !PAGE_NOISE.test(p));
  const blankSeparated = paras.filter((p) => !p).length >= paras.length * 0.25;
  const nextNonBlank = (i) => {
    for (let j = i + 1; j < paras.length; j++) if (paras[j]) return paras[j];
    return null;
  };
  // Without positions, an all-caps line followed by text could be a character or a direction.
  // Names that come back more than once are characters; a one-off needs a speech-like next line.
  const cueCounts = new Map();
  paras.forEach((p, i) => {
    if (p && isCueText(p) && nextNonBlank(i)) {
      const { name } = splitCue(p);
      cueCounts.set(name, (cueCounts.get(name) || 0) + 1);
    }
  });
  const looksLikeSpeech = (t) => t.startsWith('(') || /[a-zà-ÿ]/.test(t);

  // Some Word scripts put the name and the line together: "ANNA: Hello." (or "ANNA (V.O.): Hello.").
  const INLINE = /^([\p{Lu}][\p{Lu}0-9 .'’\-&#]{0,30}?)(\s*\([^)]*\))?\s*:\s+(\S.*)$/u;
  const inlineCount = paras.filter((p) => INLINE.test(p) && isCueText(p.match(INLINE)[1])).length;
  const useInline = inlineCount >= 2;

  const elements = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (!p) continue;
    const inline = useInline && p.match(INLINE);
    if (inline && isCueText(inline[1]) && !HEADING.test(p)) {
      const dialogue = makeDialogue(inline[1] + (inline[2] ?? ''));
      addLine(dialogue, inline[3], false);
      elements.push(dialogue);
      continue;
    }
    const next = nextNonBlank(i);
    const isCue =
      isCueText(p) &&
      next &&
      !isCueText(next) &&
      !HEADING.test(next) &&
      looksLikeSpeech(next) &&
      ((cueCounts.get(splitCue(p).name) || 0) > 1 || splitCue(p).ext || next.length < 200);
    if (isCue) {
      const dialogue = makeDialogue(p);
      let lastKind = null;
      let inParen = false;
      while (i + 1 < paras.length) {
        const t = paras[i + 1];
        if (!t) {
          if (!blankSeparated || lastKind === null) {
            i++;
            continue;
          }
          break;
        }
        if (isCueText(t) || HEADING.test(t)) break;
        const kind = inParen || t.startsWith('(') ? 'paren' : 'speech';
        // Without blank lines between elements, a speech is one paragraph (plus any parentheticals).
        if (!blankSeparated && kind === 'speech' && lastKind === 'speech') break;
        inParen = addLine(dialogue, t, inParen);
        lastKind = kind;
        i++;
      }
      elements.push(dialogue);
    } else if (HEADING.test(p)) {
      elements.push({ type: 'heading', text: p });
    } else {
      elements.push({ type: 'action', text: p });
    }
  }

  // Skip any preamble (taping instructions, character descriptions) before the script starts: the first
  // scene heading, or the first line by a character who speaks again later.
  const firstHeading = elements.findIndex((e) => e.type === 'heading');
  const speaksLater = (idx) =>
    elements.slice(idx + 1).some((e) => e.type === 'dialogue' && e.speaker === elements[idx].speaker);
  let first = elements.findIndex((e, idx) => e.type === 'dialogue' && speaksLater(idx));
  if (firstHeading >= 0 && (first < 0 || firstHeading < first)) first = firstHeading;
  if (first < 0) first = elements.findIndex((e) => e.type === 'dialogue');
  return finalize(first > 0 ? elements.slice(first) : elements);
}

// Fallback for PDFs whose layout doesn't follow screenplay indents: treat vertical gaps as blank lines.
export function linesToParagraphs(lines) {
  const paras = [];
  for (let i = 0; i < lines.length; i++) {
    const prev = lines[i - 1];
    if (prev && (prev.page !== lines[i].page || prev.y - lines[i].y > 18)) paras.push('');
    paras.push(lines[i].text);
  }
  return paras;
}

// ---------- Summary helpers ----------

export function listCharacters(elements) {
  const counts = new Map();
  for (const el of elements) {
    if (el.type === 'dialogue') counts.set(el.speaker, (counts.get(el.speaker) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, lines]) => ({ name, lines }));
}

// Accent-insensitive, so a file called "JOSE sides.pdf" still finds JOSÉ.
const plain = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

// Picks your character from the file name, matching whole words only ("ANDREW BEAUMONT sides" finds
// ANDREW but not DREW). Longer names win, so "MARY ANN" beats "MARY".
// Words that often appear in file names but are never the actor's role.
const FILE_WORDS = new Set(['SIDES', 'SIDE', 'FINAL', 'DRAFT', 'CASTING', 'AUDITION', 'SCRIPT', 'SCENE', 'SCENES', 'SELF',
  'TAPE', 'SELFTAPE', 'REV', 'REVISED', 'COPY', 'NEW', 'PDF', 'DOCX', 'GUION', 'ROTEIRO', 'ESCENA', 'CENA', 'PRUEBA', 'TESTE']);

export function guessUserCharacter(characters, fileName) {
  const words = plain(fileName.replace(/\.[^.]+$/, '')).split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const text = ` ${words.join(' ')} `;
  const hits = characters
    .map((c) => {
      const name = plain(c.name).split(/[^\p{L}\p{N}']+/u).filter(Boolean);
      if (!name.length || name.every((w) => FILE_WORDS.has(w))) return null;
      const at = text.indexOf(` ${name.join(' ')} `);
      return at < 0 ? null : { name: c.name, at };
    })
    .filter(Boolean);
  // The name that comes first in the file name wins; on a tie, the longer one ("MARY ANN" over "MARY").
  hits.sort((a, b) => a.at - b.at || b.name.length - a.name.length);
  return hits[0]?.name ?? null;
}

// Guesses the script's language from common short words in the dialogue, plus letters that only
// appear in one language (ñ ¿ ¡ for Spanish, ã õ ç for Portuguese). Words shared with English
// ("no", "do", "as", "me") aren't counted, and Spanish/Portuguese need a clear lead to win.
const LANGUAGE_WORDS = {
  en: ['the', 'you', 'and', 'what', 'is', 'it', 'i', 'to', 'that', 'this', 'don’t', "don't", 'are', 'with', 'have', 'just',
    'your', 'my', 'of', 'in', 'we', 'he', 'she', 'was', 'not', 'for', 'on', 'be', 'can', 'know', 'yes', 'okay', 'oh', 'so',
    'but', 'all', 'there', 'here', 'why', 'how', 'do', 'say', 'soon', 'as', 'it’s', "it's", 'i’m', "i'm", 'well', 'right', 'get'],
  es: ['el', 'la', 'los', 'las', 'qué', 'y', 'es', 'por', 'un', 'lo', 'pero', 'estoy', 'usted', 'yo', 'muy', 'eso', 'esto',
    'aquí', 'cómo', 'señor', 'tú', 'del', 'al', 'mi', 'voy', 'sí', 'vale', 'claro', 'bien', 'hay', 'ahora', 'también', 'cuando',
    'dónde', 'quién', 'porque', 'con', 'se', 'te', 'le', 'ya', 'tengo', 'puedo', 'quiero', 'gracias', 'hola', 'mañana', 'su',
    'nos', 'eres', 'soy', 'pues', 'oye', 'mira', 'ella', 'él', 'madre', 'padre', 'hijo', 'hija', 'casa', 'nada', 'tienes', 'vamos'],
  pt: ['o', 'os', 'é', 'não', 'uma', 'você', 'eu', 'isso', 'aqui', 'com', 'pra', 'mas', 'da', 'ele', 'ela', 'muito', 'tá', 'né',
    'então', 'também', 'oi', 'tudo', 'bem', 'obrigado', 'obrigada', 'agora', 'quando', 'onde', 'quem', 'porque', 'tenho', 'posso',
    'quero', 'sim', 'olá', 'meu', 'minha', 'seu', 'sua', 'nós', 'vou', 'vai', 'foi', 'estou', 'estava', 'fazer', 'mãe', 'pai',
    'casa', 'nada', 'tem', 'sou', 'vamos', 'aí', 'cadê', 'gente', 'nossa'],
};
const LANGUAGE_LETTERS = { es: /[ñ¿¡]/gu, pt: /[ãõç]/gu };
const ACCENTS = /[áéíóúâêôà]/gu; // used by both Spanish and Portuguese

export function detectLanguage(elements) {
  const text = elements
    .filter((e) => e.type === 'dialogue')
    .map((e) => e.text.toLowerCase())
    .join(' ');
  const words = text.split(/[^\p{L}’']+/u).filter(Boolean);
  const scores = {};
  for (const [lang, list] of Object.entries(LANGUAGE_WORDS)) {
    const set = new Set(list);
    scores[lang] = words.filter((w) => set.has(w)).length;
  }
  for (const [lang, re] of Object.entries(LANGUAGE_LETTERS)) scores[lang] += 2 * (text.match(re) || []).length;
  const accents = (text.match(ACCENTS) || []).length;
  scores.es += accents;
  scores.pt += accents;
  const other = scores.es >= scores.pt ? 'es' : 'pt';
  // Spanish or Portuguese only when the evidence is clearly ahead of English.
  if (scores[other] >= 2 && scores[other] > scores.en * 1.2) {
    if (scores.es === scores.pt) return (text.match(LANGUAGE_LETTERS.pt) || []).length > (text.match(LANGUAGE_LETTERS.es) || []).length ? 'pt' : 'es';
    return other;
  }
  return 'en';
}

// ---------- Guessing characters' genders (for default voices) ----------

// Words that say who someone is when they appear right before a name ("His wife, BRENDA").
const FEMALE_NOUNS = /(?<!\p{L})(wife|mother|mom|mum|woman|girl|sister|daughter|lady|girlfriend|aunt|grandmother|grandma|queen|mrs|ms|miss|esposa|madre|mamá|mujer|chica|niña|hermana|hija|señora|señorita|novia|tía|abuela|mãe|mulher|menina|moça|irmã|filha|senhora|namorada|avó)(?!\p{L})/iu;
const MALE_NOUNS = /(?<!\p{L})(husband|father|dad|man|boy|brother|son|guy|boyfriend|uncle|grandfather|grandpa|king|mr|esposo|marido|padre|papá|hombre|chico|niño|hermano|hijo|señor|novio|tío|abuelo|pai|homem|menino|rapaz|irmão|filho|senhor|namorado|avô)(?!\p{L})/iu;
const FEMALE_PRONOUNS = /(?<!\p{L})(she|her|hers|herself|ella|ela)(?!\p{L})/giu;
const MALE_PRONOUNS = /(?<!\p{L})(he|him|his|himself|él|ele)(?!\p{L})/giu;

/**
 * Guesses each character's gender from the stage directions: a describing word right before the
 * name counts most ("his wife, BRENDA"), then pronouns in sentences that start with the name
 * ("Charles puts his fingers to his lips."). Returns { NAME: 'F' | 'M' } for names it's fairly sure about.
 */
export function guessGenders(elements, names) {
  const scores = Object.fromEntries(names.map((n) => [n, 0]));
  const plainNames = names.map((n) => [n, plain(n.split(/\s+/)[0])]);
  const sentences = elements
    .filter((e) => e.type === 'action')
    .flatMap((e) => e.text.split(/(?<=[.!?])\s+/));
  for (const sentence of sentences) {
    const words = plain(sentence);
    for (const [name, first] of plainNames) {
      const at = words.search(new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
      if (at < 0) continue;
      // A describing noun in the three words before the name.
      const before = sentence.slice(0, Math.max(0, at)).split(/\s+/).slice(-4).join(' ');
      if (FEMALE_NOUNS.test(before)) scores[name] -= 3;
      if (MALE_NOUNS.test(before)) scores[name] += 3;
      // Pronouns only count when the sentence is about this character (starts with the name)
      // and nobody else is named in it.
      const others = plainNames.some(([n, f]) => n !== name && new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(words));
      if (at <= 1 && !others) {
        scores[name] -= (sentence.match(FEMALE_PRONOUNS) || []).length;
        scores[name] += (sentence.match(MALE_PRONOUNS) || []).length;
      }
    }
  }
  const out = {};
  for (const [name, score] of Object.entries(scores)) {
    if (score >= 2) out[name] = 'M';
    else if (score <= -2) out[name] = 'F';
  }
  return out;
}
