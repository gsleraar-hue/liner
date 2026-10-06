// Find a 30-second preview for a recommended song via the iTunes Search API (no key needed).
// Used for listening tips the site itself has no clip for. Results, including "not found",
// are kept in a small cache file so every tip is looked up only once.
const fs = require('fs');

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/\bthe\b/g, ' ').replace(/[^a-z0-9]+/g, '');
// "Rain (B-kant, 1966)" -> "Rain"; "Respect (live)" -> "Respect"
const bareTitle = t => (t || '').replace(/\s*[([].*?[)\]]/g, '').replace(/\s+[-–].*$/, '').trim();

let last = 0;
async function politely() {   // iTunes allows about 20 searches a minute
  const wait = last + 3200 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
}

async function search(term, country) {
  await politely();
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=15&country=${country}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('iTunes HTTP ' + r.status);
  return (await r.json()).results || [];
}

// Pick a result whose artist and title match what the tip names; prefer the right year.
function pick(results, want) {
  const a = norm(want.artist), t = norm(bareTitle(want.title));
  if (!a || !t) return null;
  const ok = results.filter(x => x.previewUrl &&
    (norm(x.artistName).includes(a) || a.includes(norm(x.artistName))) &&
    norm(bareTitle(x.trackName)).startsWith(t.slice(0, Math.max(6, Math.min(t.length, 14)))));
  if (!ok.length) return null;
  const sameYear = want.year && ok.find(x => (x.releaseDate || '').startsWith(want.year));
  const plain = ok.find(x => !/live|remix|karaoke|cover|instrumental/i.test(x.trackName));
  return sameYear || plain || ok[0];
}

async function findPreview(want, cacheFile) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {}
  const key = norm(want.artist) + '|' + norm(bareTitle(want.title));
  if (key in cache) return cache[key];
  let found = null;
  for (const country of ['NL', 'US']) {
    const hit = pick(await search(`${want.artist} ${bareTitle(want.title)}`, country), want);
    if (hit) { found = { audio: hit.previewUrl, artist: hit.artistName, title: bareTitle(want.title), cover: hit.artworkUrl100 || '', source: 'itunes' }; break; }
  }
  cache[key] = found;
  try { fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1)); } catch (e) {}
  return found;
}

module.exports = { findPreview };
