// What Liner keeps on disk, how big each part is, and how to clear it.
// Everything here can be made again; only speech from ElevenLabs costs credits to remake,
// so that part is kept unless the user explicitly ticks it.
// Measuring runs asynchronously in small batches, so the window stays responsive with
// thousands of files; which speech files came from ElevenLabs is remembered in an index.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

async function walk(dir, filter = () => true) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  const files = entries.filter(d => d.isFile() && filter(d.name));
  for (let i = 0; i < files.length; i += 64) {
    const batch = await Promise.all(files.slice(i, i + 64).map(async d => {
      const p = path.join(dir, d.name);
      try { const s = await fsp.stat(p); return { p, size: s.size, mtime: s.mtimeMs }; } catch (e) { return null; }
    }));
    out.push(...batch.filter(Boolean));
  }
  for (const d of entries.filter(d => d.isDirectory())) out.push(...await walk(path.join(dir, d.name), filter));
  return out;
}
const sum = files => files.reduce((a, f) => a + f.size, 0);

// Speech files: ElevenLabs delivers 44.1 kHz MPEG-1 mp3, the Microsoft voices 24 kHz MPEG-2.
// Read the first frame header to tell them apart (an ID3 tag may come first).
async function isPaidSpeech(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const b = Buffer.alloc(8192);
    const { bytesRead: n } = await fh.read(b, 0, b.length, 0);
    let i = 0;
    if (b.toString('latin1', 0, 3) === 'ID3') i = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
    for (; i + 3 < n; i++) {
      if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) return ((b[i + 1] >> 3) & 3) === 3;   // version bits 11 = MPEG-1
    }
  } catch (e) {} finally { if (fh) await fh.close().catch(() => {}); }
  return false;
}

// Split the speech cache into paid (ElevenLabs) and free, using and updating an index.
async function splitSpeech(cache) {
  const dir = path.join(cache, 'tts');
  const indexFile = path.join(dir, 'herkomst.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (e) {}
  const files = await walk(dir, n => n.endsWith('.mp3'));
  const unknown = files.filter(f => !(path.basename(f.p) in index));
  for (let i = 0; i < unknown.length; i += 64) {
    await Promise.all(unknown.slice(i, i + 64).map(async f => { index[path.basename(f.p)] = await isPaidSpeech(f.p) ? 1 : 0; }));
  }
  const names = new Set(files.map(f => path.basename(f.p)));
  for (const k of Object.keys(index)) if (!names.has(k)) delete index[k];   // forget removed files
  try { fs.writeFileSync(indexFile, JSON.stringify(index)); } catch (e) {}
  return { paid: files.filter(f => index[path.basename(f.p)] === 1), free: files.filter(f => index[path.basename(f.p)] !== 1) };
}

async function parts(userData) {
  const cache = path.join(userData, 'cache');
  const { paid, free } = await splitSpeech(cache);
  const temp = [];
  try {
    for (const d of await fsp.readdir(os.tmpdir())) if (/^liner-/.test(d)) temp.push(...(await walk(path.join(os.tmpdir(), d))).map(f => ({ ...f, dir: path.join(os.tmpdir(), d) })));
  } catch (e) {}
  const stems = (await walk(userData, n => /^stem-.*\.mp3$/.test(n))).filter(f => path.dirname(f.p) === userData);
  return {
    pcm: { label: 'Uitgepakt geluid (maakt Liner vanzelf opnieuw)', files: await walk(path.join(cache, 'pcm')), checked: true },
    previews: { label: 'Voorbeelden en proefzinnen', files: [...(await walk(cache, n => /^voorbeeld-.*\.mp3$/.test(n))).filter(f => path.dirname(f.p) === cache), ...await walk(path.join(cache, 'woord')), ...stems], checked: true },
    browser: { label: 'Browsercache van het verborgen venster', files: [...await walk(path.join(cache, 'Cache_Data')), ...await walk(path.join(userData, 'Code Cache')), ...await walk(path.join(userData, 'GPUCache'))], checked: true, viaSession: true },
    temp: { label: 'Achtergebleven tijdelijke bestanden', files: temp, checked: true },
    frag: { label: 'Gedownloade muziekfragmenten (gratis opnieuw te downloaden)', files: await walk(path.join(cache, 'frag')), checked: false },
    free: { label: 'Spraak van de gratis Microsoft-stemmen (gratis opnieuw te maken, kost tijd)', files: free, checked: false },
    paid: { label: 'Spraak van ElevenLabs (opnieuw maken kost credits!)', files: paid, checked: false }
  };
}

async function report(userData) {
  const p = await parts(userData);
  return Object.entries(p).map(([key, v]) => ({ key, label: v.label, bytes: sum(v.files), count: v.files.length, checked: v.checked }));
}

// Remove the chosen parts. The browser cache is cleared through Electron's session instead of
// deleting files that the running browser may hold open.
async function clean(userData, keys, session) {
  const p = await parts(userData);
  let freed = 0;
  for (const key of keys) {
    const part = p[key];
    if (!part) continue;
    if (part.viaSession && session) {
      try { await session.clearCache(); await session.clearCodeCaches({}); } catch (e) {}
      freed += sum(part.files) - sum((await parts(userData))[key].files);
      continue;
    }
    for (let i = 0; i < part.files.length; i += 64) {
      await Promise.all(part.files.slice(i, i + 64).map(async f => {
        try { await fsp.rm(f.p, { force: true }); freed += f.size; } catch (e) {}
        if (key === 'pcm') await fsp.rm(f.p + '.json', { force: true }).catch(() => {});
      }));
    }
    if (key === 'temp') for (const d of new Set(part.files.map(f => f.dir))) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  return freed;
}

// Keep the unpacked sound under a limit: least recently used files go first. Called after every
// preview or book and at start-up, so the cache no longer grows to many gigabytes.
async function prunePcm(userData, maxBytes = 2 * 1024 ** 3) {
  const files = (await walk(path.join(userData, 'cache', 'pcm'), n => n.endsWith('.pcm'))).sort((a, b) => a.mtime - b.mtime);
  let total = sum(files), freed = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    await fsp.rm(f.p, { force: true }).catch(() => {});
    await fsp.rm(f.p + '.json', { force: true }).catch(() => {});
    total -= f.size; freed += f.size;
  }
  return freed;
}

module.exports = { report, clean, prunePcm };
