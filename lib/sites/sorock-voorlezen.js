// Voorlezen: de browser leest het hoofdstuk voor, alinea voor alinea, met de stem van het apparaat.
(function () {
  const synth = window.speechSynthesis;
  const deck = document.querySelector('.deck');
  const book = document.querySelector('.book');
  if (!deck || !book) return;
  const store = { get(k, d) { try { const v = localStorage.getItem('sor-tts-' + k); return v === null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('sor-tts-' + k, v); } catch (e) {} } };

  // ---------- knop in het blok bovenaan ----------
  const row = document.createElement('div');
  row.className = 'deck-row';
  row.innerHTML = '<span class="lbl">Voorlezen</span><button type="button" class="btn solid tts-start"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>Lees dit hoofdstuk voor</button>';
  const lessonRow = deck.querySelector('.deck-toggle[data-target="lu"]')?.closest('.deck-row');
  // De grote knop staat niet meer bovenaan: voorlezen start via het knopje bij een alinea.
  void lessonRow;
  const startBtn = row.querySelector('.tts-start');
  if (!synth) { startBtn.disabled = true; startBtn.title = 'Deze browser kan niet voorlezen.'; return; }

  // ---------- zwevende bediening ----------
  const bar = document.createElement('div');
  bar.className = 'tts-bar'; bar.hidden = true; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Voorlezen');
  bar.innerHTML = `
    <button type="button" class="tts-prev" aria-label="Vorige alinea"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12 18 18V6z"/></svg></button>
    <button type="button" class="tts-play" aria-label="Pauze"><svg viewBox="0 0 24 24"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg></button>
    <button type="button" class="tts-next" aria-label="Volgende alinea"><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>
    <label class="tts-f">Tempo <select class="tts-rate"><option value="0.8">0,8×</option><option value="1">1×</option><option value="1.15">1,15×</option><option value="1.3">1,3×</option><option value="1.5">1,5×</option></select></label>
    <label class="tts-f tts-vwrap">Stem <select class="tts-voice"></select></label>
    <label class="tts-f"><input type="checkbox" class="tts-notes"> Luistertips</label>
    <button type="button" class="tts-close" aria-label="Stoppen met voorlezen">✕</button>`;
  document.body.appendChild(bar);
  const $ = s => bar.querySelector(s);
  $('.tts-rate').value = store.get('rate', '1');
  $('.tts-notes').checked = store.get('notes', '0') === '1';

  // ---------- stemmen ----------
  let voices = [], nlVoice = null, enVoice = null;
  function rankNl(v) { const n = v.name; return (/Natural|Online/.test(n) ? 0 : /Google/.test(n) ? 1 : 2) + (/nl-NL/i.test(v.lang) ? 0 : 0.5); }
  function loadVoices() {
    voices = synth.getVoices();
    const nl = voices.filter(v => /^nl/i.test(v.lang)).sort((a, b) => rankNl(a) - rankNl(b));
    const en = voices.filter(v => /^en/i.test(v.lang)).sort((a, b) => rankNl(a) - rankNl(b));
    enVoice = null; // alles met dezelfde Nederlandse stem; geen aparte Engelse stem voor namen
    const sel = $('.tts-voice'); sel.innerHTML = '';
    nl.forEach(v => { const o = document.createElement('option'); o.value = v.name; o.textContent = v.name.replace(/^Microsoft |^Google /, '').replace(/ - Dutch.*| \(Natural\).*|Online /g, ''); sel.appendChild(o); });
    const saved = store.get('voice', '');
    nlVoice = nl.find(v => v.name === saved) || nl[0] || null;
    if (nlVoice) sel.value = nlVoice.name;
    $('.tts-vwrap').hidden = nl.length < 2;
    // alleen een eenvoudige stem? wijs op Edge
    const good = nl.some(v => /Natural|Online|Google/.test(v.name));
    let hint = row.querySelector('.tts-hint');
    if (!good) { if (!hint) { hint = document.createElement('span'); hint.className = 'tts-hint'; row.appendChild(hint); } hint.textContent = nl.length ? 'Tip: in Microsoft Edge klinkt de voorleesstem natuurlijker.' : 'Er is geen Nederlandse stem gevonden. In Microsoft Edge werkt voorlezen het best.'; } else if (hint) hint.remove();
  }
  loadVoices();
  if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;

  // ---------- tekst verzamelen ----------
  const EN = /\b(the|of|and|you|your|my|me|love|i|in|on|is|it|to|a|be|all|girl|baby|man|night|life|time|blues|rock|song|for|with|we|this|that|don't|can't|it's|what|like|stop|go|got|get|heart|dance|world|day|way|no|yes)\b/gi;
  const NL = /\b(de|het|een|van|en|ik|je|jij|mijn|niet|maar|voor|met|zijn|wat|die|dat|naar|ook|nog|uit|als|om|op|we|wij|ze|zij|over|bij|aan|al|is|er)\b/gi;
  // Engelse namen en termen: artiesten en titels uit de gegevens van de site, plus vaste begrippen.
  let nameRe = null;
  const TERMS = ["rock-'n-roll", 'rhythm-and-blues', 'rhythm and blues', 'call and response', 'big band', 'cool jazz', 'hard bop', 'free jazz', 'new wave', 'heavy metal', 'hard rock', 'glam rock', 'soft rock', 'drum-and-bass', 'acid house', 'hip-hop', 'girl group', 'boy band', 'singer-songwriter', 'Tin Pan Alley', 'Brill Building', 'British Invasion', 'Summer of Love', 'Wall of Sound', 'Grand Ole Opry', 'field holler', 'field hollers', 'work song', 'work songs', 'spirituals', 'gospel', 'Billboard Hot 100', 'Top 40'];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function buildNames(list) {
    const seen = new Set();
    const clean = list.map(s => (s || '').replace(/\s*\((?:met|feat\.?|with)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim())
      .filter(s => s.length >= 4 && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
    clean.sort((a, b) => b.length - a.length);
    nameRe = clean.length ? new RegExp('(?<![\\p{L}\\d])(' + clean.map(esc).join('|') + ')(?![\\p{L}\\d])', 'giu') : null;
  }
  (function loadNames() {
    const root = (document.querySelector('meta[name=sor-root]') || {}).content || '..';
    const dutch = /^(De |Het |Doe Maar|Normaal|Osdorp|Extince|Typhoon|Froukje|Klein Orkest|Frank Boeijen|Boudewijn|Acda|BLØF|Golden Earring|Shocking Blue|Cuby|Tielman|Anneke|André Hazes|Johnny Jordaan|Heideroosjes|The Scene|Het Goede Doel|Q65|De Dijk|Wim Sonneveld|Toon Hermans|Jules de Corte|Herman van Veen|Ramses Shaffy|Doe|Armin|Tiësto|Ferry Corsten|Within Temptation|Epica|Rotterdam Termination|Charly Lownoise)/i;
    Promise.all([fetch(root + '/data/genres.json').then(r => r.json()).catch(() => null), fetch(root + '/data/tracks.json').then(r => r.json()).catch(() => [])]).then(([g, t]) => {
      const out = TERMS.slice();
      const nlPlace = /Nederland|Amsterdam|Rotterdam|Den Haag|Achterhoek|Oosterhout|Grolloo|Jordaan/i;
      if (g) g.genres.forEach(x => { (x.tracks || []).forEach(tr => { if (!nlPlace.test(x.place.name)) { out.push(tr.artist); out.push(tr.title); } }); });
      (t || []).forEach(tr => { if (tr.mixtape !== 11) { out.push(tr.artist); out.push(tr.title); } });
      book.querySelectorAll('aside.side-note .who').forEach(w => out.push(w.textContent));
      buildNames(out.filter(s => s && !dutch.test(s)));
    });
  })();
  window.SOR_TTS_SAY = el => collect().filter(it => it.el === el).map(it => sayParts(it.parts)).join(" ");
  window.SOR_TTS_TEST = t => { const v = enVoice; enVoice = enVoice || { lang: 'en' }; const r = splitNames(t); enVoice = v; return r; };
  // Reeksen van twee of meer woorden met een hoofdletter (Jimi Hendrix, Led Zeppelin) zijn bijna altijd Engelse namen.
  const NL_CAPS = /^(Verenigde|Staten|Tweede|Eerste|Wereldoorlog|Koude|Oorlog|Noord|Zuid|Oost|West|Den|Haag|Nederland|Nederlandse|Nederlanders|Engeland|Engelse|Amerika|Amerikaanse|Europa|Europese|Duitsland|Duitse|Frankrijk|Franse|Londen|Parijs|Brussel|Sint|Mixtape|Kant|Amerikaan|Amerikanen|Brit|Britten|Brits|Britse|Engelsman|Ier|Ierse|Schot|Schotse|Indische|Indonesië|Suriname|Antillen|Caribisch|Afrika|Afrikaanse|Azië|Latijns|Midden|Oosten|Grote|Kleine|Nieuwe|Oude|In|Op|De|Het|Een|Van|Na|Toen|Daarna|Ook|Met|Bij|Voor|Uit|Over|Zo|Dat|Die|Deze|Dit|Er|Hij|Zij|Ze|Je|Ik|We|Wie|Wat|Waar|Hoe|Maar|En|Of|Als|Om|Aan|Door|Tot|Naar|Hun|Zijn|Haar|Alle|Veel|Elke|Geen|Pas|Toch|Nu|Hier|Daar|Later|Eerst|Tijdens|Sinds|Vanaf|Rond|Begin|Eind|Halverwege|Volgens|Omdat|Terwijl|Want|Dus|Wel|Niet|Nog|Al|Zanger|Zangeres|Gitarist|Bassist|Drummer|Toetsenist|Producer|Producers|Componist|Saxofonist|Trompettist|Pianist|Album|Albums|Plaat|Platen|B-kant|A-kant|Groep|Hitlijst|Volgens|Fotograaf|Regisseur|Schrijver|Journalist|Dj|Dj's|Rapper|Rappers|Zo|Daarom)$/;
  const CAPS = /(?<![\p{L}\d])(?:The |De La )?\p{Lu}[\p{L}'’.-]+(?:\s+(?:&\s+|and\s+|of\s+|the\s+|’n\s+|'n\s+)?\p{Lu}[\p{L}'’.-]+)+/gu;
  const capsOn = document.body.dataset.mixtape !== '11';
  function splitCaps(text) {
    if (!capsOn) return [{ text, en: false }];
    const res = []; let last = 0; CAPS.lastIndex = 0; let m;
    while ((m = CAPS.exec(text))) {
      // niet over een zinseinde heen, en Nederlandse woorden aan de randen eraf
      let s = m.index, str = m[0];
      const cut = str.search(/[.!?]\s/); if (cut >= 0) { str = str.slice(0, cut + 1); CAPS.lastIndex = s + cut + 1; }
      let ws = str.split(/(\s+)/);
      const isNl = w => NL_CAPS.test(w.replace(/[.,'’]+$/, ''));
      while (ws.length && (isNl(ws[0]) || !ws[0].trim())) { s += ws[0].length; ws.shift(); }
      while (ws.length && (isNl(ws[ws.length - 1]) || !ws[ws.length - 1].trim())) ws.pop();
      str = ws.join('').replace(/[.]$/, (x) => /\p{Lu}\.$/u.test(ws.join('')) ? x : '');
      const caps = str.split(/\s+/).filter(w => /^\p{Lu}/u.test(w));
      if (caps.length < 2 || caps.some(isNl)) continue;
      if (s > last) res.push({ text: text.slice(last, s), en: false });
      res.push({ text: str, en: true }); last = s + str.length;
    }
    if (last < text.length) res.push({ text: text.slice(last), en: false });
    return res;
  }
  function splitNames(text) {
    if (!nameRe) return splitCaps(text);
    const res = []; let last = 0; nameRe.lastIndex = 0; let m;
    while ((m = nameRe.exec(text))) { if (m.index > last) res.push(...splitCaps(text.slice(last, m.index))); res.push({ text: m[0], en: true }); last = m.index + m[0].length; }
    if (last < text.length) res.push(...splitCaps(text.slice(last)));
    return res;
  }
  // cursieve tekst is een titel; die geldt als Engels, behalve als hij duidelijk Nederlands is
  function isDutch(t) { const e = (t.match(EN) || []).length, n = (t.match(NL) || []).length; return n > e; }
  function isEnglish(t) { const e = (t.match(EN) || []).length, n = (t.match(NL) || []).length; return e > n && e > 0; }
  function partsOf(el) {
    // Splits een alinea in stukken: cursieve Engelse titels krijgen een Engelse stem.
    const clone = el.cloneNode(true);
    clone.querySelectorAll('aside, figure, .label, .letter, .kicker, img, .qr, .tts-here, .note-play, button').forEach(n => n.remove());
    const out = [];
    function push(text, en) { text = text.replace(/\s+/g, ' '); if (!text) return; if (!text.trim()) { const l = out[out.length - 1]; if (l && !/\s$/.test(l.text)) l.text += ' '; return; } const last = out[out.length - 1]; if (last && last.en === en) last.text += text; else out.push({ text, en }); }
    (function walk(n) {
      n.childNodes.forEach(c => {
        if (c.nodeType === 3) splitNames(c.textContent).forEach(s => push(s.text, s.en));
        else if (c.nodeName === 'EM' || c.nodeName === 'I') { const tx = c.textContent; if (!isDutch(tx)) push(tx, true); else splitNames(tx).forEach(s => push(s.text, s.en)); }
        else { walk(c); if (/^(DIV|H[1-6]|P|LI)$/.test(c.nodeName)) { const l = out[out.length - 1]; if (l && !/[.!?:]\s*$/.test(l.text)) push('. ', false); } }
      });
    })(clone);
    return out;
  }
  function noteText(a) {
    const who = a.querySelector('.who'); const box = who ? who.parentNode : null;
    let title = ''; if (box) { let seen = false; box.childNodes.forEach(n => { if (seen) title += n.textContent; if (n.nodeName === 'BR') seen = true; }); }
    const clone = a.cloneNode(true); clone.querySelectorAll('.tag, .rec, .qr, .note-play, button').forEach(n => n.remove());
    const rest = clone.textContent.replace(/\s+/g, ' ').trim();
    const nameParts = who ? splitNames(who.textContent + ', ') : [];
    return [{ text: 'Luistertip: ', en: false }].concat(nameParts, [{ text: title.trim() + '. ', en: !isDutch(title) }], splitNames(rest));
  }
  function collect() {
    const items = [];
    const cover = book.querySelector('.opener.cover');
    if (cover) items.push({ el: cover, parts: partsOf(cover.querySelector('.cover-text') || cover) });
    book.querySelectorAll('.flow > *').forEach(el => {
      if (el.matches('.opener.part')) { const k = el.querySelector('.kicker'); items.push({ el, parts: [{ text: (k ? k.textContent.replace(/·.*$/, '').trim() + '. ' : ''), en: true }].concat(partsOf(el)) }); }
      else if (el.matches('.head')) items.push({ el, parts: partsOf(el.querySelector('h3')) });
      else if (el.matches('p')) {
        items.push({ el, parts: partsOf(el) });
        if ($('.tts-notes').checked) el.querySelectorAll('aside.side-note').forEach(a => { if (a.querySelector('.who')) items.push({ el: a, parts: noteText(a) }); });
      } else if (el.matches('aside.side-note') && $('.tts-notes').checked && el.querySelector('.who')) items.push({ el, parts: noteText(el) });
    });
    return items.filter(i => i.parts.some(p => p.text.trim()));
  }

  // ---------- uitspraaklijst ----------
  // "overal": altijd vervangen; "engels": alleen binnen Engelse namen en titels (woorden die ook Nederlands zijn).
  const lexes = { overal: { re: null, map: {} }, engels: { re: null, map: {} } };
  function compile(map) {
    const keys = Object.keys(map).sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
    return keys.length ? new RegExp('(?<![\\p{L}\\d])(' + keys.join('|') + ')(?![\\p{L}\\d])', 'gu') : null;
  }
  (function loadLex() {
    const root = (document.querySelector('meta[name=sor-root]') || {}).content || '..';
    fetch(root + '/data/uitspraak.json?v=' + Date.now(), { cache: 'no-store' }).then(r => r.json()).then(d => {
      const overal = Object.assign({}, d.woorden || {}, d.overal || {});
      lexes.overal = { map: overal, re: compile(overal) };
      lexes.engels = { map: d.engels || {}, re: compile(d.engels || {}) };
    }).catch(() => {});
  })();
  function applyLex(t, l) { return l.re ? t.replace(l.re, m => l.map[m] !== undefined ? l.map[m] : m) : t; }
  const say = (t, en) => { let s = t; if (en) s = applyLex(s, lexes.engels); return applyLex(s, lexes.overal); };
  // engels per stuk (alleen in namen en titels), daarna overal over de hele alinea, zodat ook "Roland TR-" + "808" samen worden gevonden
  const sayParts = parts => applyLex(parts.map(p => p.en ? applyLex(p.text, lexes.engels) : p.text).join(""), lexes.overal);
  window.SOR_TTS_DUMP = () => { const n = $('.tts-notes'), was = n.checked; n.checked = true; const r = collect().map(it => [{ t: it.parts.map(p => p.text).join(""), en: false, s: sayParts(it.parts) }]); n.checked = was; return r; };
  // ---------- afspelen ----------
  let items = [], idx = 0, playing = false, token = 0;
  function sentences(parts) {
    // Chrome breekt lange stukken af: knip op zinnen.
    const out = [];
    // alleen knippen na een leesteken gevolgd door een spatie, zodat U.S.A. en Sgt. heel blijven
    parts.forEach(p => { p.text.split(/(?<=[.!?;:])\s+(?=\p{Lu}|\d|$)/u).forEach(s => { if (s.trim()) out.push({ text: s + ' ', en: p.en }); }); });
    return out;
  }
  function mark(el) {
    book.querySelectorAll('.tts-now').forEach(n => n.classList.remove('tts-now'));
    if (!el) return;
    el.classList.add('tts-now');
    const r = el.getBoundingClientRect();
    if (r.top < 90 || r.bottom > innerHeight - 110) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function speakItem() {
    const my = ++token;
    if (idx >= items.length) { stop(); return; }
    const it = items[idx]; mark(it.el); savePos(it.el);
    const full = sayParts(it.parts).replace(/\s+/g, ' ');
    const chunks = sentences([{ text: full, en: false }]);
    let c = 0;
    const rate = parseFloat($('.tts-rate').value) || 1;
    (function next() {
      if (my !== token || !playing) return;
      if (c >= chunks.length) { idx++; speakItem(); return; }
      const ch = chunks[c++];
      const u = new SpeechSynthesisUtterance(ch.text);
      if (nlVoice) { u.voice = nlVoice; u.lang = nlVoice.lang; } else u.lang = 'nl-NL';
      u.rate = rate;
      u.onend = next; u.onerror = () => { if (my === token) next(); };
      synth.speak(u);
    })();
  }
  function setPlayIcon() {
    $('.tts-play').innerHTML = playing ? '<svg viewBox="0 0 24 24"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg>';
    $('.tts-play').setAttribute('aria-label', playing ? 'Pauze' : 'Verder voorlezen');
  }
  function play(from) {
    synth.cancel(); token++;
    items = collect();
    if (typeof from === 'number') idx = Math.max(0, Math.min(items.length - 1, from));
    playing = true; bar.hidden = false; document.body.classList.add('tts-on'); setPlayIcon(); speakItem();
  }
  function pause() { playing = false; token++; synth.cancel(); setPlayIcon(); }
  function stop() { playing = false; token++; synth.cancel(); mark(null); bar.hidden = true; document.body.classList.remove('tts-on'); setPlayIcon(); startLabel(); }
  // ---------- plek onthouden per hoofdstuk ----------
  const posKey = 'pos-' + location.pathname.replace(/.*\//, '');
  const anchors = () => [...book.querySelectorAll('.opener.cover, .flow > .opener.part, .flow > .head, .flow > p')];
  function savePos(el) { const host = el.closest('.flow > p') || el; const i = anchors().indexOf(host); if (i > 0) store.set(posKey, String(i)); }
  function savedIndex() {
    const i = parseInt(store.get(posKey, '0'), 10); const el = anchors()[i]; if (!i || !el) return -1;
    const list = collect(); return list.findIndex(it => it.el === el);
  }
  function startLabel() {
    const i = savedIndex();
    startBtn.lastChild.textContent = i > 0 ? 'Verder lezen' : 'Lees dit hoofdstuk voor';
    fromStart.hidden = !(i > 0);
  }
  const fromStart = document.createElement('button');
  fromStart.type = 'button'; fromStart.className = 'btn ghost tts-fromstart'; fromStart.textContent = 'Vanaf het begin';
  startBtn.after(fromStart);
  fromStart.addEventListener('click', () => { store.set(posKey, '0'); play(0); });

  // ---------- afspeelknopje bij elke alinea en tussenkop ----------
  anchors().forEach(el => {
    if (el.matches('.opener')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tts-here'; b.title = 'Lees vanaf hier voor'; b.setAttribute('aria-label', 'Lees vanaf hier voor');
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
    b.addEventListener('click', e => { e.stopPropagation(); const list = collect(); const i = list.findIndex(it => it.el === el); if (i >= 0) play(i); });
    el.classList.add('tts-anchor'); el.insertBefore(b, el.firstChild);
  });

  function firstVisible() {
    const list = collect();
    const i = list.findIndex(it => it.el.getBoundingClientRect().bottom > 110);
    return i < 0 ? 0 : i;
  }

  startBtn.addEventListener('click', () => { if (window.SOR && SOR.pause) try { SOR.pause(); } catch (e) {} const s = savedIndex(); play(s > 0 ? s : firstVisible()); });
  startLabel();
  $('.tts-play').addEventListener('click', () => (playing ? pause() : play(idx)));
  $('.tts-prev').addEventListener('click', () => play(idx - 1));
  $('.tts-next').addEventListener('click', () => play(idx + 1));
  $('.tts-close').addEventListener('click', stop);
  $('.tts-rate').addEventListener('change', e => { store.set('rate', e.target.value); if (playing) play(idx); });
  $('.tts-voice').addEventListener('change', e => { store.set('voice', e.target.value); nlVoice = voices.find(v => v.name === e.target.value) || nlVoice; if (playing) play(idx); });
  $('.tts-notes').addEventListener('change', e => { store.set('notes', e.target.checked ? '1' : '0'); if (playing) { const cur = items[idx] && items[idx].el; const list = collect(); const i = list.findIndex(it => it.el === cur); play(i < 0 ? idx : i); } });
  // Klik op een alinea terwijl er wordt voorgelezen: daar verder lezen.
  book.addEventListener('click', e => { if (bar.hidden || e.target.closest('a, button, .rec, input, select, audio') || (window.getSelection && String(window.getSelection()).length)) return; const p = e.target.closest('.flow > p, .flow > .head, aside.side-note'); if (!p) return; const list = collect(); const i = list.findIndex(it => it.el === p || it.el.contains(p)); if (i >= 0) play(i); });
  document.addEventListener('keydown', e => { if (bar.hidden || e.target.closest('input, select, textarea')) return; if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); playing ? pause() : play(idx); } });
  window.addEventListener('beforeunload', () => synth.cancel());
  document.addEventListener('sor:leave', stop); // naar een andere pagina binnen de site
})();
