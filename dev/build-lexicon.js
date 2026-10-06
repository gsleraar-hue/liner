// Builds uitspraak-elex.json: English loanwords with a spelling the Dutch/Flemish voice pronounces correctly.
// Source: e-Lex 1.1.1 (Taalunie, via INT), pronunciation in the CELEX column. Run `node dev/elex-index.js` first.
// Candidates: the anglicism list (dev/anglicismen.txt), eSpeak NG nl_list, the hand-made list, plus e-Lex words
// with typically English sounds (dZ, tS, Aj, Ow ...). Only words that go wrong when read as plain Dutch.
// Usage: node dev/build-lexicon.js [--toon word]
const fs = require('fs');
const path = require('path');
const IDX = require('./e-lex/index.json');
const HAND = require('../lib/uitspraak-algemeen.json');

// ---------- pronunciation as tokens ----------
const PH = ['E+', 'Y+', 'A+', 'E:', 'Y:', 'O:', 'E~', 'A~', 'O~', 'Y~', 'a', 'e', 'i', 'o', 'u', 'y', '2', '@', 'I', 'E', 'A', 'O', 'Y',
  'p', 'b', 't', 'd', 'k', 'g', 'f', 'v', 's', 'z', 'S', 'Z', 'x', 'G', 'h', 'm', 'n', 'N', 'J', 'l', 'r', 'w', 'j', '-', "'"];
function tokens(p) {
  const out = [];
  for (let i = 0; i < p.length;) {
    const t = PH.find(x => p.startsWith(x, i));
    if (!t) { i++; continue; }
    out.push(t); i += t.length;
  }
  return out;
}
const VOW = new Set(['E+', 'Y+', 'A+', 'E:', 'Y:', 'O:', 'E~', 'A~', 'O~', 'Y~', 'a', 'e', 'i', 'o', 'u', 'y', '2', '@', 'I', 'E', 'A', 'O', 'Y']);
const SHORT = new Set(['I', 'E', 'A', 'O', 'Y']);

// ---------- how a Dutch speaker reads the letters (without knowing the word) ----------
const G2P = [['sch', 'sx'], ['ch', 'x'], ['ng', 'N'], ['nk', 'Nk'], ['aai', 'aj'], ['ooi', 'oj'], ['oei', 'uj'], ['ieuw', 'iw'], ['eeuw', 'ew'],
  ['eau', 'o'], ['aa', 'a'], ['ee', 'e'], ['oo', 'o'], ['uu', 'y'], ['ie', 'i'], ['oe', 'u'], ['eu', '2'], ['ei', 'E+'], ['ij', 'E+'],
  ['ui', 'Y+'], ['ou', 'A+'], ['au', 'A+'], ['uw', 'yw'], ['ph', 'f'], ['th', 't'], ['qu', 'kw'], ['x', 'ks'], ['ck', 'k'],
  ['c', null], ['y', 'i'], ['g', 'G'], ['q', 'k']];
function naive(word) {
  const w = word.toLowerCase().replace(/['’.-]/g, '');
  const g = [];
  for (let i = 0; i < w.length;) {
    const r = G2P.find(([k]) => w.startsWith(k, i));
    if (r) {
      if (r[0] === 'c') g.push(/[eiy]/.test(w[i + 1] || '') ? 's' : 'k'); else g.push(...tokens(r[1]));
      i += r[0].length; continue;
    }
    g.push(w[i]); i++;
  }
  // single vowels: long in an open syllable, otherwise short; e at the end and in -en/-el/-er is a schwa
  const isV = t => VOW.has(t) || 'aeiou'.includes(t);
  const vv = g.map((t, k) => {
    if (!'aeiou'.includes(t) || t.length > 1) return t;
    const n1 = g[k + 1], n2 = g[k + 2];
    if (t === 'e' && (k === g.length - 1 || (k === g.length - 2 && /[nlr]/.test(n1)))) return '@';
    const open = n1 === undefined || (n1 && !isV(n1) && n2 && isV(n2)) || (n1 && isV(n1));
    return open ? { a: 'a', e: 'e', i: 'i', o: 'o', u: 'y' }[t] : { a: 'A', e: 'E', i: 'I', o: 'O', u: 'Y' }[t];
  });
  return vv.filter((t, k) => !(k && t === vv[k - 1] && !VOW.has(t)));
}
// close enough? voiced/voiceless and schwa don't count as a difference
const CLS = { b: 'p', d: 't', v: 'f', z: 's', G: 'x', g: 'x', Z: 'S' };
const SCHWA = new Set(['@', 'E', 'e', 'I']);
function same(a, b) {
  // syllable dashes, stress marks and glides between vowels (me-di-ja) don't count
  const flat = t => t.filter(x => x !== '-' && x !== "'").filter((x, i, arr) => !((x === 'j' || x === 'w') && VOW.has(arr[i - 1]) && VOW.has(arr[i + 1])));
  a = flat(a); b = flat(b);
  const eq = (x, y) => (CLS[x] || x) === (CLS[y] || y) || ((x === '@' && SCHWA.has(y)) || (y === '@' && SCHWA.has(x)));
  // a final schwa or a dropped n (lopen -> lope) may be missing
  const trim = t => { t = t.slice(); if (t[t.length - 1] === 'n' && t[t.length - 2] === '@') t.pop(); return t; };
  a = trim(a); b = trim(b);
  if (a.length !== b.length) return false;
  return a.every((x, i) => eq(x, b[i]));
}
const skel = t => t.filter(x => !VOW.has(x) && x !== '-' && x !== "'").map(x => CLS[x] || x).join('');
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// ---------- pronunciation -> spelling for the voice ----------
const LONG = { a: 'aa', e: 'ee', o: 'oo', y: 'uu', i: 'ie', u: 'oe', '2': 'eu', 'E+': 'ei', 'Y+': 'ui', 'A+': 'au', 'E:': 'è', 'Y:': 'eu', 'O:': 'o', 'E~': 'en', 'A~': 'an', 'O~': 'on', 'Y~': 'un', '@': 'e' };
const SH = { I: 'i', E: 'e', A: 'a', O: 'o', Y: 'u' };
const CONS = { x: 'ch', G: 'g', g: 'g', S: 'sj', Z: 'zj', N: 'ng', J: 'nj' };
function respell(p) {
  // diphthongs Dutch doesn't have: Aj -> ai, Oj -> oi, ej -> ee, ow -> oo, uw -> oe, iw -> ie
  let t = tokens(p).filter(x => x !== "'");
  const out = [];
  for (let k = 0; k < t.length; k++) {
    const x = t[k], n = t[k + 1], after = t[k + 2];
    const glideEnd = after === undefined || after === '-' && (t[k + 3] === undefined || !VOW.has(t[k + 3])) || (after && !VOW.has(after) && after !== '-');
    if (x === 'A' && n === 'j') { out.push({ s: 'ai', v: 'L' }); k++; continue; }
    if (x === 'O' && n === 'j') { out.push({ s: 'oi', v: 'L' }); k++; continue; }
    if (x === 'e' && n === 'j' && glideEnd) { out.push({ s: 'ee', v: 'L' }); k++; continue; }
    if (x === 'O' && n === 'w') { out.push({ s: 'au', v: 'L' }); k++; continue; }
    if (x === 'o' && n === 'w' && glideEnd) { out.push({ s: 'oo', v: 'L' }); k++; continue; }
    if (x === 'u' && n === 'w' && glideEnd) { out.push({ s: 'oe', v: 'L' }); k++; continue; }
    if (x === 'i' && n === 'w' && glideEnd) { out.push({ s: 'ie', v: 'L' }); k++; continue; }
    if (x === 't' && n === 'S') { out.push({ s: 'tsj', c: 1 }); k++; continue; }
    if (x === 'd' && n === 'Z') { out.push({ s: 'dzj', c: 1 }); k++; continue; }
    if (x === '-') { out.push({ s: '', b: 1 }); continue; }
    if (SH[x]) out.push({ s: SH[x], v: 'S' });
    else if (LONG[x]) out.push({ s: LONG[x], v: 'L', schwa: x === '@' });
    else out.push({ s: CONS[x] || x, c: 1, single: !CONS[x] });
  }
  // short vowel at the end of a syllable: double the next consonant (tSE-t@ -> tsjette)
  let s = '';
  for (let k = 0; k < out.length; k++) {
    const o = out[k];
    s += o.s;
    if (o.v === 'S' && out[k + 1] && out[k + 1].b && out[k + 2] && out[k + 2].single && out[k + 3] && out[k + 3].v) s += out[k + 2].s;
  }
  // undo assimilation: Ybdet -> updeet, and no double letters at the start
  return s.replace(/b(?=d)/g, 'p').replace(/^(.)\1/, '$1');
}

// ---------- candidates ----------
const lemmaForms = {};
for (const [form, rows] of Object.entries(IDX)) for (const r of rows) (lemmaForms[r[0]] || (lemmaForms[r[0]] = new Set())).add(form);
const cand = new Set();
const addWord = w => { w = w.trim(); if (!w || /\s/.test(w)) return; for (const v of [w, w.toLowerCase()]) if (IDX[v]) for (const r of IDX[v]) for (const f of lemmaForms[r[0]]) cand.add(f); };
const ang = path.join(__dirname, 'anglicismen.txt');
if (fs.existsSync(ang)) fs.readFileSync(ang, 'utf8').split(/\r?\n/).forEach(addWord);
const esp = path.join(__dirname, 'espeak-nl_list.txt');
if (fs.existsSync(esp)) fs.readFileSync(esp, 'utf8').split(/\r?\n/).filter(l => /_\^_EN/.test(l)).forEach(l => addWord(l.split(/\s/)[0]));
Object.keys(HAND.woorden).forEach(addWord);
// e-Lex words with typically English sounds you can't see from the spelling
const ENGLISH = /dZ|tS|Aj|Ow|^[^']*'?[^aeiouAEIOY]*E[^-]*$/;
for (const [form, rows] of Object.entries(IDX)) {
  if (!/^[a-z][a-z-]+$/.test(form)) continue;
  const r = rows.find(r => r[4]);
  if (!r || /eigen|deeleigen|afgebr|meta/.test(r[1])) continue;
  const p = r[4];
  // only if the spelling looks English: j/g -> dZ (jazz, gin), ch -> tS (check, lunch; not kitsch),
  // i/y -> Aj (online, style; not ei/ij/ai), ow -> Ow (download; not sovjet)
  const hit = (/dZ/.test(p) && /(^|[^d])j|g[eiy]/.test(form)) || (/tS/.test(p) && /(^|[^ts])ch/.test(form)) ||
    (/Aj/.test(p) && /(^|[^aeo])[iy](?![jy])/.test(form) && !/ei|ij|ai|ey/.test(form)) || (/Ow/.test(p) && /ow/.test(form));
  if (hit) cand.add(form);
}

// ---------- decide per word form ----------
// Dutch words that e-Lex only knows as English
const NOOIT = new Set(['plan', 'plannen', 'gepland', 'plant', 'plande', 'planden', 'assistent', 'assistenten', 'tablet', 'tabletten', 'tabletje', 'tabletjes', 'brandt']);
const out = {}, why = {};
const skipped = { gelijk: 0, dubbelzinnig: 0, onbetrouwbaar: 0 };
for (const form of [...cand].sort()) {
  const rows = IDX[form];
  if (!rows || form.length < 3 || /[^a-z'-]/.test(form)) continue;
  if (NOOIT.has(form)) continue;
  // the voice already reads Dutch -tie/-tionair/-isch (station, revolutionair, praktisch) correctly
  if (/ti[eoa]|isch/.test(form)) continue;
  const nv = naive(form);
  const prons = [...new Set(rows.map(r => r[4] || r[2]).filter(Boolean))];
  // homograph with a normal Dutch reading (file, band, post): leave it alone
  if (prons.some(p => same(tokens(p), nv))) { skipped[prons.length > 1 ? 'dubbelzinnig' : 'gelijk']++; continue; }
  if (prons.length > 1 && new Set(prons.map(respell)).size > 1) { skipped.dubbelzinnig++; continue; }
  const r = rows.find(r => r[4]) || rows[0];
  const p = r[4] || r[2];
  // the CELEX column must match the CGN column (some rows are shifted, e.g. huis -> 'wi)
  if (r[4] && r[2] && lev(skel(tokens(r[4])), skel(tokens(r[2]))) > Math.max(1, skel(tokens(r[2])).length / 3)) { skipped.onbetrouwbaar++; continue; }
  let say = respell(p);
  // restore a dropped -n (updaten -> 'Yb-de-t@)
  if (/en$/.test(form) && /@$/.test(p)) say += 'n';
  // without ch in the word, the ch sound is a g (gemaild, researchgegeven)
  if (!/ch/.test(form.replace(/[ts]ch/g, ''))) say = say.replace(/ch/g, 'g');
  if (!say || say === form) continue;
  out[form] = say; why[form] = p;
}

const arg = process.argv.indexOf('--toon');
if (arg > 0) {
  for (const w of process.argv.slice(arg + 1)) console.log(w.padEnd(14), (out[w] || '-').padEnd(16), why[w] || '', JSON.stringify((IDX[w] || []).map(r => r[4] || r[2])), naive(w).join(''));
  process.exit(0);
}
// Not in lib/: the file may not go into the public repo or the installer. Liner reads it from its user folder.
const file = path.join(process.env.APPDATA || path.join(require('os').homedir(), '.config'), 'Liner', 'uitspraak-elex.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  _uitleg: 'Gegenereerd door dev/build-lexicon.js uit e-Lex 1.1.1 (Taalunie/INT, alleen voor eigen niet-commercieel gebruik; niet verspreiden). Engelse leenwoorden en hun vervoegingen, omgezet van uitspraak naar spelling. Laagste voorrang: de handlijst uitspraak-algemeen.json gaat voor. Niet met de hand bewerken; pas de handlijst aan of draai het script opnieuw.',
  woorden: out
}, null, 1) + '\n');
console.log(Object.keys(out).length, 'woorden ->', file, skipped);
