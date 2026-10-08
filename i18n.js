// Interface language. Texts are written in English in the code and looked up in the
// dictionaries below; anything missing simply stays in English.
import { settings, saveSettings } from './settings.js';
import { es } from './i18n-es.js';
import { pt } from './i18n-pt.js';

export const UI_LANGUAGES = { en: 'English', es: 'Español', pt: 'Português' };
const DICTIONARIES = { en: {}, es, pt };

export function uiLanguage() {
  if (settings.uiLanguage && DICTIONARIES[settings.uiLanguage]) return settings.uiLanguage;
  const system = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return DICTIONARIES[system] ? system : 'en';
}

// t('Preparing line {n} of {total}…', { n: 2, total: 9 })
export function t(text, vars) {
  return tFor(uiLanguage(), text, vars);
}

// The same lookup in a specific language (e.g. the script's language for a voice test sentence).
export function tFor(lang, text, vars) {
  let out = DICTIONARIES[lang]?.[text] ?? text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return IS_TOUCH ? forTouch(out, lang) : out;
}

// On a phone or tablet there's no Space bar; the app shows a Next button instead.
const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const TOUCH_WORDS = {
  en: [[/\bpress Space\b/g, 'tap Next'], [/\bPress Space\b/g, 'Tap Next']],
  es: [[/presiona Espacio/g, 'toca Siguiente'], [/Presiona Espacio/g, 'Toca Siguiente']],
  pt: [[/aperte Espaço/g, 'toque em Próxima'], [/Aperte Espaço/g, 'Toque em Próxima']],
};
function forTouch(text, lang) {
  for (const [re, word] of TOUCH_WORDS[lang] ?? TOUCH_WORDS.en) text = text.replace(re, word);
  return text;
}

// Shows a message that is re-translated if the language changes while it's on screen.
// `key` is the English text; pass null to clear. Errors thrown with a translation key keep it.
export function setText(el, key, vars) {
  delete el.dataset.i18nDynInner;
  if (key == null) {
    delete el.dataset.i18nDyn;
    el.textContent = '';
    return;
  }
  el.dataset.i18nDyn = JSON.stringify([key, vars ?? null]);
  el.textContent = t(key, vars);
}

// An error whose message is a translation key, so it can be shown in any language.
export class AppError extends Error {
  constructor(key, vars) {
    super(t(key, vars));
    this.key = key;
    this.vars = vars;
  }
}

// Shows an error: re-translatable if it's an AppError, otherwise its message as is.
export function setErrorText(el, err, wrapperKey) {
  if (err?.key) {
    if (wrapperKey) setText(el, wrapperKey, { message: t(err.key, err.vars) });
    else setText(el, err.key, err.vars);
    // Remember the inner key so the wrapper is re-translated properly.
    if (wrapperKey) el.dataset.i18nDynInner = JSON.stringify([err.key, err.vars ?? null]);
  } else {
    setText(el, wrapperKey ?? '{message}', { message: cleanError(err) });
  }
}

// Electron prefixes errors from the main process with "Error invoking remote method …: Error: ".
export function cleanError(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

// Translates static HTML: elements marked data-i18n (text), data-i18n-placeholder and data-i18n-title.
// The English original is remembered on first use so switching languages back and forth works.
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.dataset.i18nKey ??= el.textContent.trim().replace(/\s+/g, ' ');
    el.textContent = t(el.dataset.i18nKey);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.dataset.i18nPlaceholderKey ??= el.placeholder;
    el.placeholder = t(el.dataset.i18nPlaceholderKey);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.dataset.i18nTitleKey ??= el.title;
    el.title = t(el.dataset.i18nTitleKey);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.dataset.i18nAriaKey ??= el.getAttribute('aria-label');
    el.setAttribute('aria-label', t(el.dataset.i18nAriaKey));
  }
  for (const el of root.querySelectorAll('[data-i18n-dyn]')) {
    const [key, vars] = JSON.parse(el.dataset.i18nDyn);
    const inner = el.dataset.i18nDynInner && JSON.parse(el.dataset.i18nDynInner);
    el.textContent = t(key, inner ? { ...vars, message: t(inner[0], inner[1]) } : vars);
  }
  document.documentElement.lang = uiLanguage() === 'pt' ? 'pt-BR' : uiLanguage();
}

const listeners = new Set();
export function onLanguageChange(fn) {
  listeners.add(fn);
}

export function setUiLanguage(lang) {
  settings.uiLanguage = lang; // '' = follow the computer's language
  saveSettings();
  applyTranslations();
  listeners.forEach((fn) => fn());
}
