// Interface strings live in data/i18n/<lang>.json so they can be translated
// (Gaelic and Scots are possible later additions).
let STRINGS = {};

export async function loadStrings(lang = 'en-GB') {
  const r = await fetch(`data/i18n/${lang}.json`);
  STRINGS = await r.json();
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
}

export function t(key, vars = {}) {
  let s = STRINGS[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
