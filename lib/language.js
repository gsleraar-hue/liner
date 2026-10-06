// Language per piece of text: which words the English voice reads and which the Dutch one.
// Starts from the site's own split, then applies the per-site corrections.
const fs = require('fs');
const path = require('path');

const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const wordRe = list => list.length ? new RegExp('(?<![\\p{L}\\d])(' + [...list].sort((a, b) => b.length - a.length).map(esc).join('|') + ')(?![\\p{L}\\d])', 'gu') : null;
const NL_WORDS = /(?<![\p{L}])(op|en|van|de|het|een|met|versie|uit|bij|kant|live op tv)(?![\p{L}])/iu;

function loadSite(name) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sites', name + '.json'), 'utf8'));
    const say = Object.fromEntries(Object.entries(cfg.uitspraak || {}).filter(([k]) => !k.startsWith('_')));
    return { en: wordRe(cfg.engels || []), nl: wordRe(cfg.nederlands || []), keep: new Set(cfg.engelseKoppeltekens || []), acroKeep: cfg.afkortingEngels || [], say, sayRe: wordRe(Object.keys(say)), parts: wordParts(cfg.deelwoorden) };
  } catch (e) { return { en: null, nl: null, keep: new Set(), acroKeep: [], say: {}, sayRe: null, parts: [] }; }
}

// Rules for a piece inside compound words, e.g. "band" -> "bend" in rockband, bandleider and bandje,
// except in the Dutch words that really mean a tape or a tyre (bandrecorder, plakband, banden).
function wordParts(list) {
  return (list || []).map(r => ({
    re: new RegExp(`[\\p{L}-]*${esc(r.van)}[\\p{L}-]*`, 'giu'),
    van: r.van, naar: r.naar,
    except: new Set((r.behalve || []).map(w => w.toLowerCase()))
  }));
}
function applyParts(t, site) {
  for (const r of (site && site.parts) || []) {
    t = t.replace(r.re, w => r.except.has(w.toLowerCase()) ? w
      : w.replace(new RegExp(esc(r.van), 'gi'), m => m[0] === m[0].toUpperCase() ? r.naar[0].toUpperCase() + r.naar.slice(1) : r.naar));
  }
  return t;
}

// The user's own pronunciation rules (from the pronunciation window). These take precedence over everything.
function userRules(map) {
  const m = Object.fromEntries(Object.entries(map || {}).filter(([k, v]) => k && v));
  return { map: m, re: wordRe(Object.keys(m)) };
}
// Apply the user's rules and shield them with \u0001n\u0002, so the other lists leave them alone.
function protect(t, U) {
  if (!U || !U.re) return [t, x => x];
  const saved = [];
  t = t.replace(U.re, m => { saved.push(U.map[m]); return '\u0001' + (saved.length - 1) + '\u0002'; });
  return [t, x => x.replace(/\u0001(\d+)\u0002/g, (_, i) => saved[+i])];
}

function paint(mask, re, text, val) {
  if (!re) return;
  re.lastIndex = 0; let m;
  while ((m = re.exec(text))) for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = val;
}

// parts: [{ text, en }] from the site -> improved [{ text, en }]
function refine(parts, site) {
  const text = parts.map(p => p.text).join('');
  const mask = new Array(text.length);
  let i = 0;
  for (const p of parts) for (let k = 0; k < p.text.length; k++) mask[i++] = !!p.en;
  const forced = new Array(text.length).fill(false);   // explicitly English in the list: the acronym rule doesn't apply there
  if (site) { paint(mask, site.en, text, true); paint(forced, site.en, text, true); paint(mask, site.nl, text, false); }

  let m;
  const off = (a, b) => { for (let k = a; k < b; k++) mask[k] = false; };
  // Acronyms are plain Dutch: MTV, EMI, BBC, U.S.A., R.E.M., TR-808, M/A/R/R/S, UFO's
  const token = /(?<![\p{L}\d])[\p{L}\d.\/|&'’!-]+/gu;
  while ((m = token.exec(text))) {
    const w = m[0].replace(/['’]s$/, '').replace(/[.!-]+$/, '');
    if (forced[m.index] || (w.match(/\p{Lu}/gu) || []).length < 2 || /\p{Ll}/u.test(w) || /^[IVXLC]+$/.test(w)) continue;
    // inside an English title it stays English: Born in the U.S.A., Anarchy in the UK
    let b = m.index - 1;
    while (b >= 0 && text[b] === ' ') b--;
    if (mask[m.index] && b >= 0 && mask[b] && /[\p{L}&]/u.test(text[b])) continue;
    off(m.index, m.index + m[0].length);
  }
  // Years, and Dutch additions in parentheses: (1964), (live op tv), (single, 1984 en 1985)
  const year = /(?<!\d)(1[5-9]\d\d|20\d\d)(?!\d)/g;
  while ((m = year.exec(text))) off(m.index, m.index + 4);
  const paren = /\([^()]*\)?/g;
  while ((m = paren.exec(text))) {
    if (NL_WORDS.test(m[0])) { off(m.index, m.index + m[0].length); continue; }
    if (!/(?<!\d)(1[5-9]\d\d|20\d\d)(?!\d)/.test(m[0])) continue;
    const low = /(?<![\p{L}\d'’-])\p{Ll}[\p{L}-]*/gu; let w;
    while ((w = low.exec(m[0]))) off(m.index + w.index, m.index + w.index + w[0].length);
  }
  // Dutch suffix on an English name: Roy Orbison-ballad, Fender Rhodes-piano, Blue Note-sound
  const suffix = /([\p{L}'’]+)-(\p{Ll}[\p{L}]*)/gu;
  while ((m = suffix.exec(text))) {
    if (site && site.keep.has(m[0])) continue;
    if (/^\p{Lu}/u.test(m[1]) || /^[A-Z0-9]+$/.test(m[1])) for (let k = m.index + m[1].length; k < m.index + m[0].length; k++) mask[k] = false;
  }

  // Back to parts; punctuation and spaces at the edges belong to the Dutch.
  const out = [];
  for (let k = 0; k < text.length; k++) {
    const l = out[out.length - 1];
    if (l && l.en === mask[k]) l.text += text[k]; else out.push({ text: text[k], en: mask[k] });
  }
  const clean = [];
  for (const p of out) {
    if (p.en) {
      const lead = p.text.match(/^[^\p{L}\d]*/u)[0], trail = p.text.match(/[^\p{L}\d!?]*$/u)[0];
      const core = p.text.slice(lead.length, p.text.length - trail.length);
      if (!core) { push(clean, p.text, false); continue; }
      push(clean, lead, false); push(clean, core, true); push(clean, trail, false);
    } else push(clean, p.text, false);
  }
  return clean;
}
function push(arr, text, en) {
  if (!text) return;
  const l = arr[arr.length - 1];
  if (l && l.en === en) l.text += text; else arr.push({ text, en });
}

// Acronyms spelled letter by letter with hyphens: the Dutch/Flemish voice then says the Dutch letter
// names by itself (EMI -> E-M-I, TR-808 -> T-R-8-0-8, R&B -> R en B). The user compared four
// spellings by ear and chose this one over "ee em ie", "E.M.I." and plain "EMI".
const dutchSpell = k => k.split('&')
  .map(part => part.replace(/[^\p{Lu}\d]/gu, '').split('').join('-'))
  .filter(Boolean).join(' en ');
const isAcronym = k => /^[\p{Lu}\d.&\/|*-]+$/u.test(k) && (k.match(/\p{Lu}/gu) || []).length >= 2;

// Apply the site's pronunciation list (only to what the Dutch voice reads).
// Acronyms the site spells with English letter names (EMI -> 'ie em aj') get Dutch letters,
// except the names in site.afkortingEngels (AC/DC, *NSYNC, Y.M.C.A. ...).
function lexicon(lex, site) {
  if (!lex) return null;
  const keep = new Set((site && site.acroKeep) || []);
  const o = { ...(lex.overal || {}) };
  for (const [k, v] of Object.entries(o)) if (isAcronym(k) && /\S[\s-]+\S/.test(String(v)) && !/,/.test(String(v)) && !keep.has(k)) o[k] = dutchSpell(k);
  const compile = map => wordRe(Object.keys(map || {}));
  return { o, e: lex.engels || {}, reO: compile(o), reE: compile(lex.engels) };
}
const apply = (t, re, map) => re ? t.replace(re, m => map[m] !== undefined ? map[m] : m) : t;
const years = s => s.replace(/\b(\d{4})\s?[-–]\s?(\d{4})\b/g, '$1 tot $2').replace(/\b(\d{4})[-–](\d{2})\b/g, '$1 tot $2');

// General list (uitspraak-algemeen.json) for every site, with the lowest priority.
// Words are case-insensitive and match inflections (updates, updaten, appje); acronyms match exactly as written.
const SUFFIX = "(s|['’]s|n|en|e|je|jes|tje|tjes|ten)?";
// Optional: a list generated from e-Lex in the user folder (dev/build-lexicon.js); it never ships with the app.
function loadGeneral(skip, userDir) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(__dirname, 'uitspraak-algemeen.json'), 'utf8')); } catch (e) {}
  if (userDir) try {
    const x = JSON.parse(fs.readFileSync(path.join(userDir, 'uitspraak-elex.json'), 'utf8'));
    j.woorden = { ...(x.woorden || {}), ...(j.woorden || {}) };
  } catch (e) {}
  const own = new Set([...(skip || [])].map(k => k.toLowerCase()));
  const words = Object.fromEntries(Object.entries(j.woorden || {}).filter(([k]) => !own.has(k.toLowerCase())));
  const acro = Object.fromEntries(Object.entries(j.afkortingen || {}).filter(([k]) => !own.has(k.toLowerCase())));
  const alt = keys => [...keys].sort((a, b) => b.length - a.length).map(esc).join('|');
  return {
    words, acro, list: { ...(j.woorden || {}), ...(j.afkortingen || {}) },
    reW: Object.keys(words).length ? new RegExp('(?<![\\p{L}\\d])(' + alt(Object.keys(words)) + ')' + SUFFIX + '(?![\\p{L}\\d])', 'giu') : null,
    reA: wordRe(Object.keys(acro))
  };
}
// Append the inflection to the spelling: update+n -> updeeten, app+en -> eppen, check+en -> tsjekken.
function inflect(key, say, suf) {
  if (!suf) return say;
  if (/e$/i.test(key) && !/e$/.test(say) && suf === 'n') suf = 'en';
  if (/^e/.test(suf) && /(^|[^aeiou])[aeiou][bdfgklmnprst]$/.test(say)) say += say.slice(-1);
  return say + suf;
}
function general(t, G) {
  if (!G) return t;
  if (G.reA) t = apply(t, G.reA, G.acro);
  if (G.reW) t = t.replace(G.reW, (m, w, suf) => {
    const say = G.words[w.toLowerCase()];
    if (say === undefined) return m;
    const out = inflect(w, say, suf);
    return /^\p{Lu}/u.test(w) ? out[0].toUpperCase() + out.slice(1) : out;
  });
  return t;
}

// Per-site pronunciation rules, only for the Dutch voice (e.g. rage -> raasje).
const sayNl = (t, site) => site && site.sayRe ? apply(t, site.sayRe, site.say) : t;

// Parts for the voices: [{ text, en }] with the pronunciation lists already applied to the Dutch.
function runs(parts, L, site) {
  return parts.map(p => {
    if (p.en) return { text: years(p.text).replace(/\s+/g, ' '), en: true };
    const [t, restore] = protect(p.text, site && site.user);
    return { text: restore(general(years(sayNl(applyParts(L ? apply(t, L.reO, L.o) : t, site), site)), site && site.general)).replace(/\s+/g, ' '), en: false };
  });
}

// Everything for the Dutch voice (no English voice): English parts in the site's phonetic spelling.
function dutchText(parts, L, site) {
  const [raw, restore] = protect(parts.map(p => p.en ? '\u0003' + p.text + '\u0004' : p.text).join(''), site && site.user);
  // English parts (between \u0003 and \u0004) go through the English list first, then everything through the general list
  let t = raw.replace(/\u0003([^\u0004]*)\u0004/g, (_, e) => L ? apply(e, L.reE, L.e) : e);
  if (L) t = apply(t, L.reO, L.o);
  t = applyParts(t, site);
  return restore(general(sayNl(years(t), site), site && site.general)).replace(/\s+/g, ' ').trim();
}

module.exports = { loadSite, refine, lexicon, runs, sayNl, dutchText, userRules, loadGeneral, general };
