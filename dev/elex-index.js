// Turns e-Lex (dev/e-lex/Data/e-Lex-1.1.txt) into a compact index for build-lexicon.js.
// e-Lex may not ship with the app (Taalunie license, non-commercial, no redistribution): everything stays in dev/.
// Output: dev/e-lex/index.json  { word form: [[lemma id, part of speech, NL, VL, CELEX, frequency], ...] }
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const src = path.join(__dirname, 'e-lex', 'Data', 'e-Lex-1.1.txt');
const out = path.join(__dirname, 'e-lex', 'index.json');
const ent = s => s.replace(/&([A-Za-z])(grave|acute|circ|uml|tilde|ring|cedil);/g, (_, c, d) =>
  (c + { grave: '̀', acute: '́', circ: '̂', uml: '̈', tilde: '̃', ring: '̊', cedil: '̧' }[d]).normalize('NFC'));

(async () => {
  const idx = {};
  const rl = readline.createInterface({ input: fs.createReadStream(src, 'latin1'), crlfDelay: Infinity });
  for await (const line of rl) {
    const f = line.split('\\');
    if (f.length < 18) continue;
    const form = ent(f[8]);
    if (/[\s]/.test(form)) continue;
    const row = [+f[0], f[9], f[12], f[13], f[15], +f[17] || 0];
    const list = idx[form] || (idx[form] = []);
    if (!list.some(r => r[0] === row[0] && r[2] === row[2])) list.push(row);
  }
  fs.writeFileSync(out, JSON.stringify(idx));
  console.log(Object.keys(idx).length, 'woordvormen ->', out);
})();
