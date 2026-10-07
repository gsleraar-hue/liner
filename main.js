const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { scanIndexSource, extractChapterSource, squareCoverSource } = require('./lib/extract');
const { Renderer } = require('./lib/render');
const tts = require('./lib/edge-tts');
const language = require('./lib/language');
const { findPreview } = require('./lib/itunes');
const elevenlabs = require('./lib/elevenlabs');

// The ElevenLabs API key, encrypted with Windows' own data protection (safeStorage); it is only
// ever decrypted here in the main process and only sent to ElevenLabs.
const elKeyFile = () => path.join(app.getPath('userData'), 'elevenlabs.key');
function loadElKey() {
  try { return safeStorage.decryptString(fs.readFileSync(elKeyFile())); } catch (e) { return ''; }
}
function saveElKey(key) {
  if (!key) { fs.rmSync(elKeyFile(), { force: true }); return; }
  fs.writeFileSync(elKeyFile(), safeStorage.encryptString(key));
}

const DEFAULTS = {
  engine: 'microsoft',      // 'microsoft' (free Edge voices) or 'elevenlabs' (paid, own API key)
  elVoice: '',              // ElevenLabs voice id
  elModel: 'eleven_v4',     // or 'eleven_multilingual_v2'
  url: 'https://sorock.nl/',
  voice: 'nl-NL-FennaNeural',
  voiceEn: 'en-GB-RyanNeural',
  // English names and titles: 'lijst' = Dutch respelling from the pronunciation lists,
  // 'raw' = as written, 'voice' = read by an English voice
  enMode: 'lijst',
  acroStyle: 'en',   // acronyms: 'en' = English letter names (em-tie-vie), 'nl' = Dutch (M-T-V)
  voiceNames: 'auto',
  rate: 1,
  quotes: true,
  tipsRead: true,
  fragments: true,
  fragLen: 20,
  bed: true,
  bedVolume: 0.5,
  transitions: true,
  introOutro: true,
  saveBook: true,        // one .m4b with chapters
  saveChapters: false,   // a separate mp3 per chapter
  outDir: path.join(os.homedir(), 'Audioboeken')
};

let win = null;
let job = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const loadSettings = () => {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch (e) { return { ...DEFAULTS }; }
  if (s.format) { s.saveBook = s.format !== 'mp3'; s.saveChapters = s.format === 'mp3'; delete s.format; }   // setting from before 0.2
  if (!s.v3) { s.englishVoice = false; s.v3 = true; }   // 0.3: one continuous voice by default; the English voice stays optional
  if (!s.enMode) s.enMode = s.englishVoice ? 'voice' : 'lijst';   // 0.6: the checkbox became a three-way choice
  delete s.englishVoice;
  return s;
};
const saveSettings = s => { try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch (e) {} };

function findFfmpeg() {
  const bundled = path.join(process.resourcesPath || '', 'bin', 'ffmpeg.exe');
  if (app.isPackaged && fs.existsSync(bundled)) return bundled;
  const dev = path.join(__dirname, 'build', 'cache', 'ffmpeg-win32-x64.exe');
  if (fs.existsSync(dev)) return dev;
  try { return execFileSync('where', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch (e) { return 'ffmpeg'; }
}

// Load pages in a hidden window, so pages built with JavaScript work too.
let reader = null;
async function runInPage(url, source) {
  if (!reader || reader.isDestroyed()) {
    // offscreen: the page then paints without a visible window, needed for the cover capture
    reader = new BrowserWindow({ show: false, width: 800, height: 800, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
    reader.webContents.setFrameRate(10);
    reader.webContents.setAudioMuted(true);
    // if a page crashes this window, throw it away; the next page gets a fresh one
    const r = reader;
    r.webContents.on('render-process-gone', (e, d) => { logError('reader', `${d.reason} (exit ${d.exitCode})`); if (!r.isDestroyed()) r.destroy(); if (reader === r) reader = null; });
  }
  const wc = reader.webContents;
  let onLoad, onFail, t;
  const loaded = new Promise((resolve, reject) => {
    t = setTimeout(() => reject(new Error('Pagina laadt niet binnen 40 seconden: ' + url)), 40000);
    onLoad = () => resolve();
    onFail = (e, code, desc, u, isMain) => { if (isMain !== false) reject(new Error(`Pagina niet te laden (${desc}): ${url}`)); };
    wc.once('did-finish-load', onLoad);
    wc.once('did-fail-load', onFail);
  }).finally(() => { clearTimeout(t); wc.removeListener('did-finish-load', onLoad); wc.removeListener('did-fail-load', onFail); });
  await reader.loadURL(url).catch(() => {});
  await loaded;
  await new Promise(r => setTimeout(r, 700));
  return reader.webContents.executeJavaScript(source, true);
}

// Capture a header of the loaded page as a square jpeg (800 x 800). Returns null if it isn't there.
async function captureCover(selector, hide, out) {
  const side = await reader.webContents.executeJavaScript(squareCoverSource(selector, hide), true);
  if (!side) return null;
  await new Promise(r => setTimeout(r, 1500));   // let the background photo and font load
  reader.webContents.invalidate();
  await new Promise(r => setTimeout(r, 400));
  const img = await reader.webContents.capturePage({ x: 0, y: 0, width: side, height: side });
  if (img.isEmpty()) return null;
  fs.writeFileSync(out, img.toJPEG(90));
  return out;
}

// Read the start page, plus the book cover: the big header of the start page, without buttons.
async function scanSite(url) {
  const res = await runInPage(url, scanIndexSource);
  const dir = path.join(app.getPath('userData'), 'cache', 'covers');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'boek-' + require('crypto').createHash('sha1').update(url).digest('hex').slice(0, 12) + '.jpg');
  try { res.coverFile = await captureCover('section.hero, .hero', '.btn, button, nav', out); } catch (e) { res.coverFile = null; }
  return res;
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
const sanitize = s => (s || 'Luisterboek').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Luisterboek';

function bookTexts(book, opts) {
  const voiceName = (opts.voiceLabel || opts.voice.split('-')[2] || '').replace(/Neural$/, '');
  return {
    introText: [book.title + '.', book.subtitle ? book.subtitle + '.' : '', book.author ? 'Door ' + book.author + '.' : ''].filter(Boolean).join(' '),
    outroText: `Dit was ${book.title}${book.author ? ', door ' + book.author : ''}. Voorgelezen door ${voiceName}.`
  };
}

// Language rules per site (lib/sites/<name>.json) plus the site's own pronunciation list.
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch (e) { return 'site'; } };
const userLexFile = url => path.join(app.getPath('userData'), 'uitspraak', hostOf(url) + '.json');
// Copies of a site's own read-aloud files that Liner carries along (lib/sites/<name>-voorlezen.js and
// <name>-uitspraak.json), used when the site itself no longer serves them.
function siteFallback(url) {
  const base = path.join(__dirname, 'lib', 'sites', hostOf(url));
  const read = f => { try { return fs.readFileSync(base + f, 'utf8'); } catch (e) { return null; } };
  const helper = read('-voorlezen.js'), lexText = read('-uitspraak.json');
  if (!helper && !lexText) return null;
  return { helper, lex: lexText ? JSON.parse(lexText) : null };
}
const loadUserLex = url => { try { return JSON.parse(fs.readFileSync(userLexFile(url), 'utf8')); } catch (e) { return {}; } };

function attachLanguage(data, url, opts = {}) {
  const site = language.loadSite(hostOf(url));
  // ElevenLabs reads Dutch and English itself: the text goes as written, with only the user's own
  // rules. The respelling lists were made for the Microsoft voices and would only get in the way.
  if (opts.engine === 'elevenlabs') {
    site.user = language.userRules(loadUserLex(url));
    data.lang = null;
    data.dutch = text => language.plainText([{ text, en: false }], site);
    for (const s of data.segs || []) {
      if (s.parts && !(s.kind === 'quote' && s.en)) s.text = language.plainText(s.parts, site);
      if (s.byParts) s.by = language.plainText(s.byParts, site);
    }
    return;
  }
  // The app's own corrections for this site (lib/sites/<site>.json "uitspraak") and the user's own
  // rules both go before the site's list; the user's rules win over the app's.
  site.user = language.userRules({ ...site.say, ...loadUserLex(url) });
  // No list from the page (or no page at all, as in the voice sample): use the copy Liner carries.
  if (!data.lex || !Object.keys(data.lex.overal || {}).length) {
    const fb = siteFallback(url);
    if (fb && fb.lex) data.lex = { overal: { ...(fb.lex.woorden || {}), ...(fb.lex.overal || {}) }, engels: fb.lex.engels || {} };
  }
  // enMode "raw": English names and titles go to the voice as written; only acronyms are respelled.
  const full = language.lexicon(data.lex, site, opts.acroStyle || 'en');
  const lex = opts.enMode === 'raw' ? language.acronymsOnly(full) : full;
  // general list, minus the words the site or the user already handles
  site.general = language.loadGeneral([...Object.keys(site.user.map), ...Object.keys(site.say), ...(lex ? [...Object.keys(lex.o), ...Object.keys(lex.e)] : [])], app.getPath('userData'));
  data.lang = parts => language.runs(language.refine(parts, site), lex, site);
  // Text the app writes itself (intro, outro) goes through the same pronunciation lists.
  data.dutch = text => language.dutchText(language.refine([{ text, en: false }], site), lex, site);
  // also when everything goes through the Dutch voice (no English voice)
  for (const s of data.segs || []) {
    if (s.parts && !(s.kind === 'quote' && s.en)) s.text = language.dutchText(s.parts, lex, site);
    else if (s.text && !(s.kind === 'quote' && s.en)) s.text = language.general(language.sayNl(s.text, site), site.general);
    if (s.byParts) s.by = language.dutchText(s.byParts, lex, site);
  }
}

// "Automatic": an English voice of the same gender as the narrator.
function resolveOpts(opts) {
  const o = { ...opts };
  if (o.engine === 'elevenlabs') {
    // one multilingual voice for everything, English quotes included
    o.voice = 'el:' + o.elVoice;
    o.voiceEn = o.voice;
    o.englishVoice = false;
    return o;
  }
  o.englishVoice = o.enMode === 'voice';
  if (!o.voiceNames || o.voiceNames === 'auto') o.voiceNames = /Maarten|Arnaud/.test(o.voice) ? 'en-US-AndrewNeural' : 'en-US-AvaNeural';
  return o;
}

// Fetch, plan, mix and encode one chapter.
async function renderChapter(r, ch, i, n, opts, book, tmp, extra = {}) {
  const label = `Hoofdstuk ${i + 1} van ${n}`;
  send('progress', { label, phase: 'tekst ophalen', chapter: i, chapters: n });
  const data = await runInPage(ch.url, extractChapterSource(siteFallback(ch.url)));
  if (!data || !data.segs || data.segs.length < 2) throw new Error('Geen leesbare tekst gevonden op ' + ch.url);
  const title = data.kicker ? `${data.kicker}: ${data.title}` : (data.title || ch.title);
  r.onProgress = p => send('progress', { label, title, phase: p.phase, done: p.done, total: p.total, chapter: i, chapters: n });
  // Listening tips the site has no clip for: look for a 30-second preview on iTunes.
  const missing = data.segs.filter(s => s.kind === 'tip' && !s.track && s.want && s.want.artist && s.want.title);
  if (missing.length) {
    const cacheFile = path.join(app.getPath('userData'), 'cache', 'itunes.json');
    let found = 0;
    for (let k = 0; k < missing.length; k++) {
      r.check();
      send('progress', { label, title, phase: 'ontbrekende fragmenten zoeken', done: k, total: missing.length, chapter: i, chapters: n });
      try { const t = await findPreview(missing[k].want, cacheFile); if (t) { missing[k].track = t; found++; } }
      catch (e) { logError('itunes', e.message); }
    }
    send('log', `${title}: ${found} van ${missing.length} ontbrekende fragmenten gevonden via iTunes`);
  }
  const nTips = data.segs.filter(s => s.kind === 'tip' && s.track).length;
  attachLanguage(data, ch.url, opts);
  // cover for this chapter: the page header, otherwise the background photo
  let coverFile = null;
  if (!extra.limitSec) {
    const out = path.join(tmp, `cover-${String(i + 1).padStart(2, '0')}.jpg`);
    try { coverFile = await captureCover('.opener.cover', '', out); } catch (e) { send('log', 'Cover niet vast te leggen: ' + e.message); }
    if (!coverFile && data.cover) { try { coverFile = await r.coverJpg(data.cover, out); } catch (e) {} }
  }
  send('log', `${title}: ${data.segs.length} stukken, ${nTips} fragmenten`);
  const texts = bookTexts(book, opts);
  // With the English voice on, render.js splits these texts itself; otherwise apply the lists here.
  if (!opts.englishVoice) for (const k of ['introText', 'outroText']) texts[k] = data.dutch(texts[k]);
  const plan = await r.plan(data, opts, { first: i === 0, last: i === n - 1, book: { ...book, ...texts }, limitSec: extra.limitSec });
  const pcm = path.join(tmp, `ch${String(i + 1).padStart(2, '0')}.pcm`);
  const frames = await r.mix(plan, pcm, 'mixen');
  if (extra.report) extra.report.timeline = plan.events.filter(e => e.kind !== 'stem').map(e => `${e.kind} ${(e.start / 44100).toFixed(1)}s +${(e.length / 44100).toFixed(1)}s`);
  return { pcm, frames, title, cover: coverFile };
}

// Settings for the Renderer when the narrator is an ElevenLabs voice.
function elConfig(opts) {
  if (opts.engine !== 'elevenlabs') return null;
  const key = loadElKey();
  if (!key) throw new Error('Vul eerst je ElevenLabs-sleutel in (bij Stem).');
  if (!opts.elVoice) throw new Error('Kies eerst een ElevenLabs-stem.');
  return { key, model: opts.elModel || 'eleven_v4' };
}

async function build(rawOpts, book, chapters, { preview } = {}) {
  const opts = resolveOpts(rawOpts);
  const r = new Renderer({ ffmpeg: findFfmpeg(), cacheDir: path.join(app.getPath('userData'), 'cache'), onLog: m => send('log', m), elevenlabs: elConfig(opts) });
  job = r;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liner-'));
  const paidNote = () => { if (r.el) send('log', `ElevenLabs: ${r.paidChars.toLocaleString('nl-NL')} tekens gebruikt (al eerder gemaakte stukken kosten niets).`); };
  try {
    if (preview) {
      const res = await renderChapter(r, chapters[0], preview.first ? 0 : 1, preview.first ? 1 : 3, opts, book, tmp, { limitSec: 150, report: preview.report });
      const out = path.join(app.getPath('userData'), 'cache', `voorbeeld-${Date.now()}.mp3`);
      for (const old of fs.readdirSync(path.dirname(out)).filter(x => x.startsWith('voorbeeld-'))) fs.rmSync(path.join(path.dirname(out), old), { force: true });
      await r.encode(res.pcm, out, { format: 'mp3' });
      paidNote();
      return { file: out };
    }

    fs.mkdirSync(opts.outDir, { recursive: true });
    const name = sanitize(book.title);
    // cover for the whole book: captured when reading the start page, otherwise the cover of chapter 1
    let cover = book.coverFile && fs.existsSync(book.coverFile) ? book.coverFile : null;
    const parts = [];
    for (let i = 0; i < chapters.length; i++) {
      r.check();
      const res = await renderChapter(r, chapters[i], i, chapters.length, opts, book, tmp);
      if (!cover && book.cover) { try { cover = await r.coverJpg(book.cover, path.join(tmp, 'cover.jpg')); } catch (e) { send('log', 'Geen omslag: ' + e.message); } }
      if (!cover && res.cover) cover = res.cover;
      send('progress', { label: `Hoofdstuk ${i + 1} van ${chapters.length}`, title: res.title, phase: 'opslaan', chapter: i, chapters: chapters.length });
      const nr = String(i + 1).padStart(2, '0');
      if (opts.saveChapters) {
        const dir = path.join(opts.outDir, name);
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, `${nr} - ${sanitize(res.title)}.mp3`);
        await r.encode(res.pcm, out, { format: 'mp3', cover: res.cover || cover, meta: { title: res.title, album: book.title, artist: book.author, album_artist: book.author, track: `${i + 1}/${chapters.length}`, genre: 'Audiobook' } });
      }
      if (opts.saveBook) {
        const out = path.join(tmp, `ch${nr}.m4a`);
        await r.encode(res.pcm, out, { format: 'm4a' });
        parts.push({ file: out, frames: res.frames, title: res.title, cover: res.cover });
      }
      fs.rmSync(res.pcm, { force: true });
    }
    // File to show: the .m4b, or the folder of separate chapters if those are all there is
    let result = path.join(opts.outDir, name);
    if (opts.saveBook) {
      send('progress', { label: 'Afronden', phase: 'luisterboek samenvoegen', chapter: chapters.length - 1, chapters: chapters.length });
      result = path.join(opts.outDir, name + '.m4b');
      await r.m4b(parts, result, { title: book.title, author: book.author, cover, tmp });
    }
    paidNote();
    return { file: result };
  } finally {
    job = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function friendly(e) {
  if (e && e.cancelled) return { cancelled: true };
  let msg = (e && e.message) || String(e);
  if (/EPERM|EACCES/.test(msg)) msg += '\n\nWindows blokkeert schrijven in deze map (waarschijnlijk "Beheerde maptoegang" van Defender). Kies een andere map, bijvoorbeeld een map in je gebruikersmap buiten Documenten en Bureaublad.';
  return { error: msg };
}

ipcMain.handle('settings', () => loadSettings());

// Pronunciation window: the site's list + own rules, saving, and speaking a single word.
ipcMain.handle('lexicon-list', async (e, url) => {
  let site = {};
  try {
    const r = await fetch(new URL('/data/uitspraak.json', url));
    if (r.ok) { const u = await r.json(); site = { ...(u.engels || {}), ...(u.woorden || {}), ...(u.overal || {}) }; }
  } catch (err) {}
  if (!Object.keys(site).length) {   // the site no longer serves its list: use the copy Liner carries
    const fb = siteFallback(url);
    if (fb && fb.lex) site = { ...(fb.lex.engels || {}), ...(fb.lex.woorden || {}), ...(fb.lex.overal || {}) };
  }
  const own = language.loadSite(hostOf(url));
  return { host: hostOf(url), site: { ...language.loadGeneral([], app.getPath('userData')).list, ...site, ...own.say }, user: loadUserLex(url) };
});
ipcMain.handle('lexicon-set', (e, { url, map }) => {
  try {
    fs.mkdirSync(path.dirname(userLexFile(url)), { recursive: true });
    fs.writeFileSync(userLexFile(url), JSON.stringify(map, null, 2));
    return { ok: true };
  } catch (err) { return friendly(err); }
});
ipcMain.handle('say', async (e, { text, voice, rate }) => {
  try {
    const dir = path.join(app.getPath('userData'), 'cache', 'woord');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, require('crypto').createHash('sha1').update(`${voice}|${rate}|${text}`).digest('hex') + '.mp3');
    if (!fs.existsSync(out)) fs.writeFileSync(out, await tts.synthesize(text, { voice, rate }));
    return { file: out };
  } catch (err) { return friendly(err); }
});
ipcMain.handle('voices', async () => {
  try {
    const all = await tts.listVoices();
    return all.filter(v => /^(nl|en)-/.test(v.Locale)).map(v => ({ id: v.ShortName, locale: v.Locale, gender: v.Gender, name: v.ShortName.split('-')[2].replace(/Neural$/, '') }));
  } catch (e) { return { error: e.message }; }
});
// ElevenLabs: store the key (after checking it), and fetch voices and remaining balance for the window.
ipcMain.handle('el-key', async (e, key) => {
  key = (key || '').trim();
  try {
    if (!key) { saveElKey(''); return { ok: true, cleared: true }; }
    const sub = await elevenlabs.subscription(key);   // throws on a wrong key
    saveElKey(key);
    return { ok: true, sub };
  } catch (err) { return friendly(err); }
});
ipcMain.handle('el-info', async () => {
  const key = loadElKey();
  if (!key) return { hasKey: false };
  try {
    const [voices, sub] = await Promise.all([elevenlabs.listVoices(key), elevenlabs.subscription(key).catch(() => null)]);
    return { hasKey: true, voices, sub };
  } catch (err) { return { hasKey: true, ...friendly(err) }; }
});

ipcMain.handle('scan', async (e, url) => {
  try { return await scanSite(url); } catch (err) { return friendly(err); }
});
ipcMain.handle('sample', async (e, { voice, rate, opts }) => {
  try {
    const nl = voice.startsWith('nl') || voice.startsWith('el:');
    if (nl && opts) {
      // sample sentence with English names in it, via the same path as the audiobook,
      // so the sample shows the chosen way of saying English names
      const o = resolveOpts({ ...opts, voice, rate, fragments: false, bed: false, transitions: false, introOutro: false });
      const parts = [{ text: 'In 1965 nam ', en: false }, { text: 'Paul McCartney', en: true }, { text: ' het nummer ', en: false }, { text: 'Yesterday', en: true }, { text: ' op, met een strijkkwartet. Later draaide MTV de clip van ', en: false }, { text: 'Smells Like Teen Spirit', en: true }, { text: ' van ', en: false }, { text: 'Nirvana', en: true }, { text: '.', en: false }];
      const data = { segs: [{ kind: 'title', text: parts.map(p => p.text).join(''), parts }] };
      attachLanguage(data, opts.url || DEFAULTS.url, o);
      const r = new Renderer({ ffmpeg: findFfmpeg(), cacheDir: path.join(app.getPath('userData'), 'cache'), elevenlabs: elConfig(o) });
      const plan = await r.plan(data, o, { first: false, last: false, book: {} });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liner-'));
      const out = path.join(app.getPath('userData'), `stem-${Date.now()}.mp3`);
      for (const old of fs.readdirSync(app.getPath('userData')).filter(x => x.startsWith('stem-'))) fs.rmSync(path.join(app.getPath('userData'), old), { force: true });
      try { await r.mix(plan, path.join(tmp, 's.pcm'), 'mixen'); await r.encode(path.join(tmp, 's.pcm'), out, { format: 'mp3' }); }
      finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      return { file: out };
    }
    const text = nl ? 'Op 6 juli 1957 speelde een groepje schooljongens skiffle op een kerkfeest in Woolton, een dorp bij Liverpool.' : "We were just a band who made it very, very big, that's all.";
    const buf = await tts.synthesize(text, { voice, rate });
    const out = path.join(app.getPath('userData'), `stem-${Date.now()}.mp3`);
    for (const old of fs.readdirSync(app.getPath('userData')).filter(x => x.startsWith('stem-'))) fs.rmSync(path.join(app.getPath('userData'), old), { force: true });
    fs.writeFileSync(out, buf);
    return { file: out };
  } catch (err) { return friendly(err); }
});
ipcMain.handle('preview', async (e, { opts, book, chapter, first }) => {
  saveSettings(opts);
  try { return await build(opts, book, [chapter], { preview: { first } }); } catch (err) { return friendly(err); }
});
ipcMain.handle('build', async (e, { opts, book, chapters }) => {
  saveSettings(opts);
  try { return await build(opts, book, chapters); } catch (err) { return friendly(err); }
});
ipcMain.handle('cancel', () => { if (job) job.cancel(); });
ipcMain.handle('pick-folder', async (e, current) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('reveal', (e, p) => { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) shell.openPath(p); else shell.showItemInFolder(p); });
ipcMain.handle('open-file', (e, p) => shell.openPath(p));

// Headless smoke test: npm run smoke [-- url]. Writes the result to smoke.json in userData.
async function smoke() {
  const report = {};
  const url = process.argv.find(a => /^https?:/.test(a)) || DEFAULTS.url;
  try {
    const idx = await scanSite(url);
    report.index = { title: idx.title, author: idx.author, chapters: idx.chapters.filter(c => c.selected).map(c => c.url) };
    const ch = idx.chapters.find(c => c.selected && c.url !== url && (!process.env.LINER_CH || c.url.includes(process.env.LINER_CH))) || idx.chapters[0];
    const data = await runInPage(ch.url, extractChapterSource(siteFallback(ch.url)));
    report.chapter = { url: ch.url, title: data.title, kinds: data.segs.reduce((m, s) => (m[s.kind] = (m[s.kind] || 0) + 1, m), {}), noTrack: data.segs.filter(s => s.kind === 'tip' && !s.track).length, sample: data.segs.filter(s => s.kind !== 'p').slice(0, 8) };
    if (process.env.LINER_FULL) {
      const chosen = idx.chapters.filter(c => c.selected).slice(-2);
      const t1 = Date.now();
      const full = await build({ ...DEFAULTS, saveChapters: true, outDir: path.join(app.getPath('userData'), 'test') }, { title: idx.title, subtitle: idx.subtitle, author: 'Jan-Wolter Smit', cover: idx.cover, coverFile: idx.coverFile }, chosen);
      report.full = { file: full.file, seconds: (Date.now() - t1) / 1000 };
    }
    const t0 = Date.now();
    const res = await build({ ...DEFAULTS, ...(process.env.LINER_VOICE ? { voice: process.env.LINER_VOICE } : {}) }, { title: idx.title, author: idx.author }, [ch], { preview: { first: true, report } });
    report.preview = { file: res.file, seconds: (Date.now() - t0) / 1000 };
  } catch (e) { report.error = e.stack || String(e); }
  fs.writeFileSync(path.join(app.getPath('userData'), 'smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.error ? 1 : 0);
}

// Dev helper: read all chapters and write out the language split (npm start -- --analyze <output.json>).
async function analyze() {
  const outFile = process.argv[process.argv.indexOf('--analyze') + 1];
  const idx = await runInPage(DEFAULTS.url, scanIndexSource);
  const chapters = [];
  for (const c of idx.chapters.filter(c => c.selected)) {
    const d = await runInPage(c.url, extractChapterSource(siteFallback(c.url)));
    chapters.push({ url: c.url, mixtape: d.mixtape, segs: d.segs.map(s => ({ kind: s.kind, parts: s.parts, byParts: s.byParts, en: s.en })) });
    console.log(c.url, d.segs.length);
  }
  fs.writeFileSync(outFile, JSON.stringify(chapters));
  app.exit(0);
}

// ---------- Updates ----------
// New versions come from the GitHub releases of gsleraar-hue/liner (see build.publish in
// package.json). The update downloads in the background and installs when the app quits,
// or straight away when the user clicks "Nu herstarten" - but never while a book is being made.
let updateState = { state: 'idle' };
function setupUpdater() {
  if (!app.isPackaged) return;   // a development copy has no app-update.yml to check against
  const { autoUpdater } = require('electron-updater');
  const logFile = path.join(app.getPath('userData'), 'update.log');
  const log = (...a) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch (e) {} };
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const report = (state, extra = {}) => { updateState = { state, ...extra }; send('update', updateState); };
  autoUpdater.on('update-available', i => report('downloading', { version: i && i.version, percent: 0 }));
  autoUpdater.on('download-progress', p => report('downloading', { version: updateState.version, percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', i => report('ready', { version: i && i.version }));
  autoUpdater.on('update-not-available', () => report('current', { version: app.getVersion() }));
  autoUpdater.on('error', e => { log('error', e && e.message); report('error', { message: String((e && e.message) || e).slice(0, 200) }); });
  const check = () => autoUpdater.checkForUpdates().catch(e => log('check failed', e && e.message));
  setTimeout(check, 10000);                 // let the app start in peace first
  setInterval(check, 6 * 60 * 60 * 1000);   // and look again every six hours
  ipcMain.handle('update-install', () => { if (job) return { busy: true }; autoUpdater.quitAndInstall(); return { ok: true }; });
}
ipcMain.handle('update-state', () => ({ ...updateState, current: app.getVersion() }));

app.whenReady().then(() => {
  if (process.argv.includes('--smoke')) return smoke();
  if (process.argv.includes('--analyze')) return analyze();
  win = new BrowserWindow({
    width: 1120, height: 800, minWidth: 900, minHeight: 640,
    title: 'Liner', backgroundColor: '#F3EFE6',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  setupUpdater();
  win.on('closed', () => { win = null; if (job) job.cancel(); app.quit(); });
  // A crashed or frozen page: log it, and bring the window back instead of leaving it blank.
  win.webContents.on('render-process-gone', (e, d) => {
    logError('window', `${d.reason} (exit ${d.exitCode})`);
    if (d.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });
  win.on('unresponsive', () => logError('window', 'not responding'));
  win.webContents.on('console-message', (e, level, message, line, source) => { if (level >= 3) logError('page', `${message} (${source}:${line})`); });
  // The hidden reader window loads outside pages; if one of those crashes, start a fresh one next time.
  app.on('child-process-gone', (e, d) => logError('process', `${d.type}: ${d.reason} (exit ${d.exitCode})`));
});

// Anything that goes wrong is written to %APPDATA%\Liner\fouten.log, so a crash can be traced afterwards.
function logError(where, what) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'fouten.log'), `${new Date().toISOString()} [${app.getVersion()}] ${where}: ${what}\n`); } catch (e) {}
}
process.on('uncaughtException', err => {
  logError('main', err && err.stack || String(err));
  if (win && !win.isDestroyed()) dialog.showMessageBox(win, { type: 'error', title: 'Liner', message: 'Er ging iets mis', detail: String(err && err.message || err) + '\n\nDe details staan in fouten.log in %APPDATA%\\Liner.' }).catch(() => {});
});
process.on('unhandledRejection', err => logError('main', 'unhandled: ' + (err && err.stack || String(err))));
app.on('window-all-closed', () => { if (!process.argv.includes('--smoke') && !process.argv.includes('--analyze')) app.quit(); });
