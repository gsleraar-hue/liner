const $ = s => document.querySelector(s);
const L = window.liner;
let settings = {};
let book = null;            // { title, subtitle, author, cover, chapters: [...] }
let busy = false;
let lastFile = null;

const fields = ['engine', 'elModel', 'voice', 'voiceEn', 'enMode', 'acroStyle', 'voiceNames', 'rate', 'quotes', 'tipsRead', 'fragments', 'fragLen', 'bed', 'bedVolume', 'transitions', 'introOutro', 'saveBook', 'saveChapters'];

function readOpts() {
  const o = { ...settings, url: $('#url').value.trim() };
  for (const k of fields) {
    const el = $('#' + k);
    o[k] = el.type === 'checkbox' ? el.checked : (el.type === 'range' || k === 'rate') ? parseFloat(el.value) : el.value;
  }
  o.outDir = settings.outDir;
  o.elVoice = $('#elVoice').value || settings.elVoice || '';
  o.voiceLabel = (o.engine === 'elevenlabs' ? ($('#elVoice').selectedOptions[0] || {}).dataset?.name : ($('#voice').selectedOptions[0] || {}).dataset?.name) || '';
  return o;
}
function readBook() {
  return { title: $('#title').value.trim() || 'Luisterboek', subtitle: $('#subtitle').value.trim(), author: $('#author').value.trim(), cover: book ? book.cover : '', coverFile: book ? book.coverFile : null };
}
function syncSliders() {
  if (typeof updateBuild === 'function' && settings.voice) updateBuild();
  $('#fragLenOut').textContent = $('#fragLen').value + ' s';
  $('#bedVolumeOut').textContent = Math.round($('#bedVolume').value * 100) + '%';
  $('#fragLen').closest('.slider').classList.toggle('disabled', !$('#fragments').checked);
  $('#bedVolume').closest('.slider').classList.toggle('disabled', !$('#bed').checked);
  const enVoice = $('#enMode').value === 'voice';
  $('#voiceNames').closest('label').classList.toggle('disabled', !enVoice);
  $('#voiceNames').disabled = !enVoice;
}
function selected() { return book ? book.chapters.filter(c => c.selected) : []; }
function updateBuild() {
  const n = selected().length;
  $('#chapCount').textContent = book ? `${n} van ${book.chapters.length} gekozen` : '';
  $('#build').disabled = busy || !n || !($('#saveBook').checked || $('#saveChapters').checked);
  document.querySelectorAll('.try, #scanBtn, #sample').forEach(b => { b.disabled = busy; });
}

function renderChapters() {
  const ol = $('#chapters');
  ol.innerHTML = '';
  if (!book || !book.chapters.length) { ol.innerHTML = '<li class="empty">Geen pagina\'s gevonden.</li>'; return updateBuild(); }
  book.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.classList.toggle('off', !c.selected);
    li.innerHTML = `<input type="checkbox"><div><div class="t"></div><div class="s"></div><div class="u"></div></div><button type="button" class="btn ghost try">Voorbeeld</button>`;
    li.querySelector('.t').textContent = c.title;
    li.querySelector('.s').textContent = c.sub || '';
    li.querySelector('.u').textContent = c.url.replace(/^https?:\/\//, '');
    const cb = li.querySelector('input');
    cb.checked = !!c.selected;
    cb.addEventListener('change', () => { c.selected = cb.checked; li.classList.toggle('off', !cb.checked); updateBuild(); });
    li.querySelector('.try').addEventListener('click', () => preview(c, i));
    c.li = li;
    ol.appendChild(li);
  });
  updateBuild();
}

// ---------- status bar at the bottom ----------
function showStatus(label, phase) {
  $('#status').hidden = false;
  $('#stLabel').textContent = label || '';
  $('#stPhase').textContent = phase || '';
}
function setBusy(b) {
  busy = b;
  $('#cancel').hidden = !b;
  if (b) { $('#reveal').hidden = true; $('#player').hidden = true; $('#player').pause(); }
  updateBuild();
}
function log(msg) {
  const el = $('#log');
  el.textContent += (el.textContent ? '\n' : '') + msg;
  el.scrollTop = el.scrollHeight;
}
let total = 1;
L.onProgress(p => {
  const per = 1 / Math.max(1, p.chapters || 1);
  const phaseShare = { 'tekst ophalen': 0, 'stemmen en muziek': 0.05, 'mixen': 0.75, 'opslaan': 0.92, 'luisterboek samenvoegen': 0.98 };
  const base = phaseShare[p.phase] ?? 0;
  const next = { 'stemmen en muziek': 0.75, 'mixen': 0.92 }[p.phase] ?? base;
  const frac = p.total ? base + (next - base) * (p.done / p.total) : base;
  $('#stBar').style.width = Math.min(100, ((p.chapter || 0) + frac) * per * 100 * (total > 1 || p.chapters > 1 ? 1 : 1)) + '%';
  const count = p.total && (p.phase === 'stemmen en muziek' || p.phase === 'ontbrekende fragmenten zoeken') ? ` (${p.done}/${p.total})` : '';
  showStatus(p.title ? `${p.label} · ${p.title}` : p.label, p.phase + count + '…');
  book && book.chapters.forEach(c => c.li && c.li.classList.remove('busy'));
  const cur = currentRun[p.chapter];
  if (cur && cur.li) cur.li.classList.add('busy');
});
L.onLog(log);
let currentRun = [];

// ---------- actions ----------
$('#scanForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (busy) return;
  let url = $('#url').value.trim();
  if (!/^https?:\/\//.test(url)) { url = 'https://' + url; $('#url').value = url; }
  setBusy(true); showStatus('Ophalen', url); $('#stBar').style.width = '15%';
  const r = await L.scan(url);
  setBusy(false);
  if (r.error) { showStatus('Ophalen mislukt', r.error); $('#stBar').style.width = '0'; return; }
  book = r;
  $('#title').value = r.title || '';
  $('#subtitle').value = r.subtitle || '';
  if (r.author || !$('#author').value) $('#author').value = r.author || '';
  $('#stBar').style.width = '100%';
  showStatus('Klaar', `${r.chapters.length} pagina's gevonden`);
  renderChapters();
  settings.url = url;
});

$('#all').addEventListener('click', () => { if (!book) return; book.chapters.forEach(c => { c.selected = true; }); renderChapters(); });
$('#none').addEventListener('click', () => { if (!book) return; book.chapters.forEach(c => { c.selected = false; }); renderChapters(); });

async function preview(c, i) {
  if (busy) return;
  setBusy(true);
  currentRun = [c];
  $('#log').textContent = '';
  showStatus('Voorbeeld', 'eerste twee à drie minuten van ' + c.title);
  $('#stBar').style.width = '0';
  const first = selected()[0] === c || (!selected().length && i === 0);
  const r = await L.preview({ opts: readOpts(), book: readBook(), chapter: { url: c.url, title: c.title }, first });
  setBusy(false);
  c.li && c.li.classList.remove('busy');
  if (r.cancelled) return showStatus('Gestopt', '');
  if (r.error) return showStatus('Voorbeeld mislukt', r.error);
  $('#stBar').style.width = '100%';
  showStatus('Voorbeeld klaar', c.title);
  const p = $('#player'); p.hidden = false; p.src = L.fileUrl(r.file); p.play();
}

$('#sample').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  showStatus('Stem', 'proefzin maken…');
  const opts = readOpts();
  const voice = opts.engine === 'elevenlabs' ? 'el:' + opts.elVoice : $('#voice').value;
  const r = await L.sample({ voice, rate: parseFloat($('#rate').value), opts });
  setBusy(false);
  if (r.error) return showStatus('Stem mislukt', r.error);
  showStatus('Stem', $('#voice').selectedOptions[0].textContent);
  const p = $('#player'); p.hidden = false; p.src = L.fileUrl(r.file); p.play();
});
$('#voiceEn').addEventListener('change', async () => {
  if (busy) return;
  const r = await L.sample({ voice: $('#voiceEn').value, rate: parseFloat($('#rate').value) });
  if (r.file) { const p = $('#player'); $('#status').hidden = false; p.hidden = false; p.src = L.fileUrl(r.file); p.play(); }
});

$('#build').addEventListener('click', async () => {
  const chosen = selected();
  if (!chosen.length || busy) return;
  setBusy(true);
  currentRun = chosen;
  book.chapters.forEach(c => c.li && c.li.classList.remove('done'));
  $('#log').textContent = '';
  $('#stBar').style.width = '0';
  const r = await L.build({ opts: readOpts(), book: readBook(), chapters: chosen.map(c => ({ url: c.url, title: c.title })) });
  setBusy(false);
  book.chapters.forEach(c => c.li && c.li.classList.remove('busy'));
  if (r.cancelled) return showStatus('Gestopt', 'er is niets opgeslagen');
  if (r.error) return showStatus('Mislukt', r.error);
  chosen.forEach(c => c.li && c.li.classList.add('done'));
  $('#stBar').style.width = '100%';
  lastFile = r.file;
  showStatus('Klaar', r.file);
  $('#reveal').hidden = false;
});

$('#cancel').addEventListener('click', () => { L.cancel(); showStatus('Stoppen', 'even geduld…'); });
$('#reveal').addEventListener('click', () => lastFile && L.reveal(lastFile));
$('#logBtn').addEventListener('click', () => { $('#log').hidden = !$('#log').hidden; });
$('#pick').addEventListener('click', async () => {
  const p = await L.pickFolder(settings.outDir);
  if (p) { settings.outDir = p; $('#outDir').textContent = p; $('#outDir').title = p; }
});
['fragments', 'bed', 'fragLen', 'bedVolume', 'enMode', 'saveBook', 'saveChapters'].forEach(id => $('#' + id).addEventListener('input', syncSliders));

// ---------- start ----------
(async () => {
  settings = await L.settings();
  $('#url').value = settings.url || '';
  for (const k of fields) {
    const el = $('#' + k);
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else if (el.tagName !== 'SELECT' || ['rate', 'enMode', 'acroStyle', 'engine', 'elModel'].includes(k)) el.value = settings[k];
  }
  $('#rate').value = String(settings.rate);
  $('#outDir').textContent = settings.outDir; $('#outDir').title = settings.outDir;
  syncSliders();
  showEngine();

  const fill = (sel, list, current) => {
    sel.innerHTML = '';
    list.forEach(v => {
      const o = document.createElement('option');
      o.value = v.id; o.dataset.name = v.name;
      o.textContent = `${v.name} · ${v.locale.endsWith('BE') ? 'Vlaams' : v.locale.startsWith('nl') ? 'Nederlands' : v.locale} · ${v.gender === 'Female' ? 'vrouw' : 'man'}`;
      sel.appendChild(o);
    });
    sel.value = current;
    if (!sel.value && list[0]) sel.value = list[0].id;
  };
  const fallback = [
    { id: 'nl-NL-FennaNeural', name: 'Fenna', locale: 'nl-NL', gender: 'Female' },
    { id: 'nl-NL-ColetteNeural', name: 'Colette', locale: 'nl-NL', gender: 'Female' },
    { id: 'nl-NL-MaartenNeural', name: 'Maarten', locale: 'nl-NL', gender: 'Male' },
    { id: 'nl-BE-DenaNeural', name: 'Dena', locale: 'nl-BE', gender: 'Female' },
    { id: 'nl-BE-ArnaudNeural', name: 'Arnaud', locale: 'nl-BE', gender: 'Male' },
    { id: 'en-GB-RyanNeural', name: 'Ryan', locale: 'en-GB', gender: 'Male' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB', gender: 'Female' },
    { id: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male' }
  ];
  let voices = await L.voices();
  if (!Array.isArray(voices) || !voices.length) voices = fallback;
  fill($('#voice'), voices.filter(v => v.locale.startsWith('nl')), settings.voice);
  const english = voices.filter(v => /^en-(GB|US|IE|AU)/.test(v.locale) && !/Multilingual/.test(v.id));
  fill($('#voiceEn'), english, settings.voiceEn);
  fill($('#voiceNames'), english, settings.voiceNames);
  const auto = document.createElement('option');
  auto.value = 'auto'; auto.textContent = 'Automatisch (past bij de verteller)';
  $('#voiceNames').prepend(auto);
  $('#voiceNames').value = settings.voiceNames || 'auto';
  syncSliders();
  updateBuild();
  if (settings.url) $('#scanForm').requestSubmit();
})();

// ---------- pronunciation window ----------
const lex = { site: {}, user: {}, url: '' };
let lexTimer = null;
const lexSave = () => { clearTimeout(lexTimer); lexTimer = setTimeout(() => L.lexiconSet({ url: lex.url, map: lex.user }), 400); };
async function lexPlay(text) {
  if (!text.trim()) return;
  const r = await L.say({ text, voice: $('#voice').value, rate: parseFloat($('#rate').value) });
  if (r.error) { $('#lexFoot').textContent = r.error; return; }
  const a = $('#lexAudio'); a.src = L.fileUrl(r.file); a.play();
}
function lexRow(word, isNew) {
  const own = word in lex.user;
  const say = own ? lex.user[word] : (lex.site[word] || '');
  const row = document.createElement('div');
  row.className = 'lexRow' + (own ? ' own' : '');
  row.innerHTML = '<button type="button" class="play" title="Zoals het er staat">▶</button>' +
    (isNew ? '<input class="w" placeholder="Woord in de tekst">' : '<div class="w"></div>') +
    '<button type="button" class="play" title="Met jouw uitspraak">▶</button><input class="s" placeholder="Zo uitspreken" spellcheck="false">' +
    '<button type="button" class="link undo"' + (own && !isNew ? '' : ' hidden') + '>herstel</button>';
  const w = row.querySelector('.w'), s = row.querySelector('.s');
  if (isNew) w.value = ''; else { w.textContent = word; w.title = word; }
  s.value = say;
  const key = () => isNew ? w.value.trim() : word;
  const [p1, p2] = row.querySelectorAll('.play');
  p1.addEventListener('click', () => lexPlay(key()));
  p2.addEventListener('click', () => lexPlay(s.value || key()));
  s.addEventListener('keydown', e => { if (e.key === 'Enter') lexPlay(s.value || key()); });
  s.addEventListener('input', () => {
    const k = key(); if (!k) return;
    if (s.value.trim() && s.value !== lex.site[k]) lex.user[k] = s.value; else delete lex.user[k];
    row.classList.toggle('own', k in lex.user);
    row.querySelector('.undo').hidden = !(k in lex.user) || !!isNew;
    lexSave(); lexCount();
  });
  row.querySelector('.undo').addEventListener('click', () => { delete lex.user[word]; lexSave(); lexRender(); });
  return row;
}
function lexCount() {
  const n = Object.keys(lex.user).length;
  $('#lexFoot').textContent = (n ? n + (n === 1 ? ' eigen aanpassing' : ' eigen aanpassingen') : 'Nog geen eigen aanpassingen') + ' · ' + Object.keys(lex.site).length + ' woorden in de lijsten (site + algemeen)';
}
function lexRender() {
  const q = $('#lexSearch').value.trim().toLowerCase();
  const words = [...new Set([...Object.keys(lex.user), ...Object.keys(lex.site)])]
    .filter(w => !w.startsWith('_') && (!q || w.toLowerCase().includes(q) || String(lex.user[w] || lex.site[w] || '').toLowerCase().includes(q)))
    .sort((a, b) => ((b in lex.user) - (a in lex.user)) || a.localeCompare(b, 'nl'));
  const box = $('#lexRows'); box.innerHTML = '';
  if (q && !words.some(w => w.toLowerCase() === q)) {
    const add = lexRow('', true);
    add.querySelector('input.w').value = $('#lexSearch').value.trim();
    box.appendChild(add);
  }
  words.slice(0, 150).forEach(w => box.appendChild(lexRow(w)));
  if (words.length > 150) { const m = document.createElement('p'); m.className = 'muted'; m.textContent = (words.length - 150) + ' meer; zoek om te vinden.'; box.appendChild(m); }
  lexCount();
}
$('#lexOpen').addEventListener('click', async () => {
  lex.url = $('#url').value.trim() || settings.url;
  const r = await L.lexiconList(lex.url);
  lex.site = r.site || {}; lex.user = r.user || {};
  $('#lexSearch').value = '';
  lexRender();
  $('#lexDlg').showModal();
  $('#lexSearch').focus();
});
$('#lexSearch').addEventListener('input', lexRender);
$('#lexAdd').addEventListener('click', () => { const r = lexRow('', true); $('#lexRows').prepend(r); r.querySelector('input.w').focus(); });
$('#lexClose').addEventListener('click', () => $('#lexDlg').close());

// ---------- updates ----------
function showUpdate(u) {
  const box = $('#update'), btn = $('#updateBtn');
  if (!u || u.state === 'downloading') {
    box.hidden = !u;
    if (u) $('#updateText').textContent = `Nieuwe versie ${u.version || ''} wordt gedownload… ${u.percent ? u.percent + '%' : ''}`;
    btn.hidden = true;
  } else if (u.state === 'ready') {
    box.hidden = false;
    $('#updateText').textContent = `Versie ${u.version} staat klaar; wordt geïnstalleerd als je Liner afsluit.`;
    btn.hidden = false;
  } else box.hidden = true;   // current, error, idle: nothing to say
}
L.onUpdate(showUpdate);
L.updateState().then(u => {
  if (u.current) $('.brand p').textContent += ' · versie ' + u.current;   // so we always know which version is running
  if (u.state === 'downloading' || u.state === 'ready') showUpdate(u);
});
$('#updateBtn').addEventListener('click', async () => {
  const r = await L.updateInstall();
  if (r && r.busy) $('#updateText').textContent = 'Eerst het luisterboek afmaken; daarna kun je herstarten.';
});

// ---------- ElevenLabs ----------
// Show the right controls for the chosen voice service; for ElevenLabs, fetch voices and balance.
function showEngine() {
  const el = $('#engine').value === 'elevenlabs';
  $('#elBox').hidden = !el;
  $('#msBox').hidden = el;
  if (el) loadEl();
}
function elStatus(text, kind) {
  const p = $('#elStatus');
  p.textContent = text;
  p.className = 'muted small' + (kind ? ' ' + kind : '');
}
let elLoaded = false;
async function loadEl(force) {
  if (elLoaded && !force) return;
  elStatus('Stemmen ophalen…');
  const r = await L.elInfo();
  if (!r.hasKey) { elStatus('Maak gratis een account op elevenlabs.io (10.000 credits per maand) en plak hierboven je API-sleutel.'); return; }
  if (r.error) { elStatus(r.error, 'bad'); return; }
  elLoaded = true;
  $('#elKey').placeholder = 'opgeslagen (versleuteld)';
  const sel = $('#elVoice');
  sel.innerHTML = '';
  // voices that list Dutch first
  const dutch = v => (v.languages || []).some(l => /^nl|dutch/i.test(l)) || /dutch|flemish|nederlands|vlaams/i.test(JSON.stringify(v.labels || {}));
  const voices = [...r.voices].sort((a, b) => (dutch(b) - dutch(a)) || a.name.localeCompare(b.name));
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.id; o.dataset.name = v.name;
    const l = v.labels || {};
    o.textContent = [v.name, dutch(v) ? 'Nederlands' : '', l.gender, l.accent].filter(Boolean).join(' · ');
    sel.appendChild(o);
  }
  if (settings.elVoice && voices.some(v => v.id === settings.elVoice)) sel.value = settings.elVoice;
  if (r.sub && r.sub.limit) {
    const left = Math.max(0, r.sub.limit - r.sub.used);
    // ElevenLabs counts credits: Multilingual v2 costs 1 credit per character, Eleven v4 about 0.11 (Oct 2026)
    elStatus(`Tegoed: ${left.toLocaleString('nl-NL')} van ${r.sub.limit.toLocaleString('nl-NL')} credits deze periode. Een voorbeeld kost met Eleven v4 zo'n 300 credits, met Multilingual v2 zo'n 2.500.`, 'ok');
  } else elStatus(`${voices.length} stemmen gevonden.`, 'ok');
}
$('#engine').addEventListener('change', showEngine);
$('#elVoice').addEventListener('change', () => { settings.elVoice = $('#elVoice').value; });
$('#elKeySave').addEventListener('click', async () => {
  const key = $('#elKey').value.trim();
  if (!key) return;
  elStatus('Sleutel controleren…');
  const r = await L.elKey(key);
  if (r.error) { elStatus(r.error, 'bad'); return; }
  $('#elKey').value = '';
  await loadEl(true);
});

// ---------- clean-up ----------
const mb = b => b >= 1024 ** 3 ? (b / 1024 ** 3).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + ' GB' : Math.round(b / 1024 ** 2).toLocaleString('nl-NL') + ' MB';
let cleanParts = [];
function cleanSum() {
  const keys = [...document.querySelectorAll('#cleanRows input:checked')].map(i => i.value);
  const bytes = cleanParts.filter(p => keys.includes(p.key)).reduce((a, p) => a + p.bytes, 0);
  const all = cleanParts.reduce((a, p) => a + p.bytes, 0);
  $('#cleanTotal').textContent = `Totaal ${mb(all)} · aangevinkt ${mb(bytes)}`;
  $('#cleanGo').disabled = !keys.length || busy;
  return keys;
}
async function cleanLoad() {
  $('#cleanRows').innerHTML = '<p class="muted">Meten…</p>';
  $('#cleanGo').disabled = true;
  cleanParts = await L.cacheReport();
  const box = $('#cleanRows'); box.innerHTML = '';
  for (const p of cleanParts) {
    const row = document.createElement('label');
    row.className = 'cleanRow' + (p.key === 'paid' ? ' paid' : '');
    row.innerHTML = '<input type="checkbox"><span class="label"></span><span class="size"></span>';
    row.querySelector('input').value = p.key;
    row.querySelector('input').checked = p.checked && p.bytes > 0;
    row.querySelector('.label').textContent = p.label;
    row.querySelector('.size').textContent = p.bytes ? mb(p.bytes) : 'leeg';
    row.querySelector('input').addEventListener('change', cleanSum);
    box.appendChild(row);
  }
  cleanSum();
}
$('#cleanOpen').addEventListener('click', () => { $('#cleanDlg').showModal(); cleanLoad(); });
$('#cleanClose').addEventListener('click', () => $('#cleanDlg').close());
$('#cleanGo').addEventListener('click', async () => {
  const keys = cleanSum();
  if (keys.includes('paid') && !confirm('Spraak van ElevenLabs verwijderen? Opnieuw maken kost dan weer credits.')) return;
  $('#cleanGo').disabled = true;
  $('#cleanTotal').textContent = 'Opruimen…';
  const r = await L.cacheClean(keys);
  if (r.busy) { $('#cleanTotal').textContent = 'Er wordt nu een luisterboek gemaakt; ruim op als dat klaar is.'; return; }
  if (r.error) { $('#cleanTotal').textContent = r.error; return; }
  await cleanLoad();
  $('#cleanTotal').textContent = `${mb(r.freed)} vrijgemaakt. ` + $('#cleanTotal').textContent;
});
