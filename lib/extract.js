// Scripts that run on the page itself, in a hidden window. They must be self-contained:
// they are sent to the page as text and executed there.

// Start page: title, author, cover and the pages that can become chapters.
function scanIndex() {
  const abs = h => { try { const u = new URL(h, location.href); u.hash = ''; return u.href; } catch (e) { return null; } };
  const meta = n => (document.querySelector(`meta[name="${n}"],meta[property="${n}"]`) || {}).content || '';
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const h1 = document.querySelector('h1');
  const title = clean(meta('og:site_name') || meta('og:title') || (h1 && h1.innerText) || document.title.split(/\s[·|–-]\s/)[0]);
  const subtitle = clean(meta('description') || (document.title.split(/\s[·|–-]\s/)[1] || ''));
  const author = clean(meta('author'));
  const coverMeta = meta('og:image');

  const here = abs(location.href);
  const seen = new Set([here]);
  const links = [];
  document.querySelectorAll('a[href]').forEach(a => {
    const href = abs(a.getAttribute('href'));
    if (!href || seen.has(href)) return;
    const u = new URL(href);
    if (u.origin !== location.origin) return;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|mp3|m4a|mp4|docx?|xlsx?|pptx?)$/i.test(u.pathname)) return;
    if (a.closest('header nav, footer')) return;
    seen.add(href);
    const strong = a.querySelector('h1,h2,h3,h4,strong,b');
    const small = a.querySelector('small');
    const head = clean(strong ? strong.innerText : '');
    const name = (head ? (small ? clean(small.innerText) + ': ' : '') + head : '') || clean(a.innerText).slice(0, 90) || u.pathname;
    const sub = clean(a.querySelector('p') ? a.querySelector('p').innerText : '');
    links.push({ url: href, title: name, sub, pattern: u.pathname.replace(/\d+/g, '#') });
  });
  // Pages with the same URL pattern (mixtape/01, mixtape/02 ...) are almost always the chapters.
  const count = {};
  links.forEach(l => { count[l.pattern] = (count[l.pattern] || 0) + 1; });
  const best = Object.entries(count).filter(([p, n]) => n >= 3 && /#/.test(p)).sort((a, b) => b[1] - a[1])[0];
  links.forEach(l => { l.selected = !!best && l.pattern === best[0]; });
  links.sort((a, b) => (b.selected - a.selected));
  const chapters = [{ url: here, title: 'Deze pagina zelf', sub: clean(document.title), selected: !best }].concat(links);
  return { title, subtitle, author, cover: coverMeta ? abs(coverMeta) : '', chapters };
}

// One chapter: a list of segments (title, headings, paragraphs, quotes, listening tips with a clip).
async function extractChapter(fallback) {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const abs = h => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
  const years = s => s.replace(/\b(\d{4})\s?[-–]\s?(\d{4})\b/g, '$1 tot $2').replace(/\b(\d{4})[-–](\d{2})\b/g, '$1 tot $2');
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const book = document.querySelector('.book');
  const flow = document.querySelector('.book .flow');

  // ---------- School of Rock-style reader ----------
  if (book && flow) {
    for (let i = 0; i < 50 && !window.SOR; i++) await wait(100);
    const SOR = window.SOR;
    const rootMeta = (document.querySelector('meta[name=sor-root]') || {}).content || '..';
    const load = p => fetch(new URL(rootMeta + '/' + p, location.href)).then(r => r.ok ? r.json() : null).catch(() => null);
    // tips-audio.json (since 2026-10-06): the site's own clips for tips that have none in the lesson
    const [tracks, siteLex, genres, tipsAudio] = await Promise.all([load('data/tracks.json'), load('data/uitspraak.json'), load('data/genres.json'), load('data/tips-audio.json')]);
    // The site dropped its read-aloud feature on 2026-10-06; Liner carries the last versions of
    // data/uitspraak.json and assets/voorlezen.js itself (lib/sites/sorock-*) and passes them in.
    const lex = siteLex || (fallback && fallback.lex) || null;

    // The site's own read-aloud helper: which parts are English, how a listening tip sounds.
    let H = null;
    const vs = [...document.scripts].find(s => /voorlezen\.js/.test(s.src));
    if (vs || (fallback && fallback.helper)) {
      try {
        const src = vs ? await fetch(vs.src).then(r => r.ok ? r.text() : (fallback && fallback.helper) || '') : fallback.helper;
        const a = src.indexOf('// ---------- tekst verzamelen'), b = src.indexOf('function collect');
        if (a > 0 && b > a) {
          H = new Function('book', src.slice(a, b) + '\nreturn { partsOf, noteText, isEnglish, ready: () => !!nameRe };')(book);
          for (let i = 0; i < 40 && !H.ready(); i++) await wait(100);
        }
      } catch (e) { H = null; }
    }
    const strip = el => { const c = el.cloneNode(true); c.querySelectorAll('aside, figure, .label, .letter, .kicker, img, .qr, .tts-here, .note-play, button').forEach(n => n.remove()); return c; };
    const partsOf = el => H ? H.partsOf(strip(el)) : [{ text: strip(el).textContent, en: false }];
    const isEnglish = t => H ? H.isEnglish(t) : /\b(the|you|and|we|was|were|that|my)\b/i.test(t) && !/\b(de|het|een|en|ik|niet)\b/i.test(t);

    // Pronunciation list: "overal" always, "engels" only in English parts.
    const compile = map => { const keys = Object.keys(map || {}).sort((x, y) => y.length - x.length).map(k => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')); return keys.length ? new RegExp('(?<![\\p{L}\\d])(' + keys.join('|') + ')(?![\\p{L}\\d])', 'gu') : null; };
    const overal = Object.assign({}, (lex && lex.woorden) || {}, (lex && lex.overal) || {});
    const engels = (lex && lex.engels) || {};
    const reO = compile(overal), reE = compile(engels);
    const apply = (t, re, map) => re ? t.replace(re, m => map[m] !== undefined ? map[m] : m) : t;
    const say = parts => clean(years(parts.map(p => apply(p.en ? apply(p.text, reE, engels) : p.text, reO, overal)).join('')));
    // Raw parts (without the pronunciation list) for the English voice; the app applies the list itself.
    const raw = parts => { const out = []; parts.forEach(p => { const t = p.text.replace(/\s+/g, ' '); if (!t) return; const l = out[out.length - 1]; if (l && l.en === !!p.en) l.text += t; else out.push({ text: t, en: !!p.en }); }); return out; };
    const textParts = t => { const d = document.createElement('div'); d.textContent = t; return partsOf(d); };

    // Link a listening tip to a clip, the way the site's chapter.js does.
    // Pop reader: data-mixtape="3". The film reader (sorock.nl/film) uses "film-1" and puts each
    // tip's clip straight on the tip (data-audio); the pop data files must not be used there.
    const N = /^\d+$/.test(document.body.dataset.mixtape || '') ? +document.body.dataset.mixtape : null;
    const pop = N !== null;
    const mine = pop ? (tracks || []).filter(t => t.mixtape === N) : [];
    const norm = s => (SOR ? SOR.norm(s) : (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''));
    const key = (a, t) => norm(a) + '|' + norm((t || '').replace(/\(.*?\)/g, '')).slice(0, 14);
    const byKey = new Map(mine.map(t => [key(t.artist, t.title), t]));
    const all = (tracks || []).concat(...((genres && genres.genres) || []).map(g => g.tracks || [])).filter(t => t && t.audio);
    const byKeyAll = new Map(all.map(t => [key(t.artist, t.title), t]));
    // Artist and title as printed in the tip: "The Quarrymen" / "In Spite of All the Danger (1958)".
    function whoOf(note) {
      const who = note.querySelector('.who'); if (!who) return null;
      const rec = note.querySelector('.rec');
      const lines = rec ? rec.innerText.split('\n').map(s => s.trim()).filter(Boolean) : [];
      const artist = who.textContent.trim();
      const line = lines.find(l => l !== artist) || '';
      return { artist, title: line.replace(/\s*\(\d{4}\)\s*$/, ''), year: (line.match(/\((\d{4})\)\s*$/) || [])[1] || '' };
    }
    function trackFor(note) {
      const w = whoOf(note); if (!w) return null;
      const { artist, title } = w;
      // a clip on the tip itself (film reader) wins
      if (note.dataset.audio) {
        const img = note.querySelector('.rec img');
        return { audio: abs(note.dataset.audio), artist, title, cover: img ? img.src : '' };
      }
      if (!pop) return null;
      let t = byKey.get(key(artist, title));
      if (!t) { const c = mine.filter(x => norm(x.artist) === norm(artist)); t = c.find(x => norm(x.title).startsWith(norm(title).slice(0, 6))) || (c.length === 1 ? c[0] : null); }
      // then the site's supplement for tips without a clip in the lesson, matched the way chapter.js does
      if (!t || !t.audio) t = (tipsAudio || []).find(x => x.mixtape === N && norm(x.artist) === norm(artist) && norm(x.title) === norm(title)) || t;
      // fallback: the same track elsewhere on the site (another chapter or the genre map), only on artist + title
      if (!t || !t.audio) t = byKeyAll.get(key(artist, title)) || all.find(x => norm(x.artist) === norm(artist) && title && norm(x.title).startsWith(norm(title).slice(0, 8)));
      return t && t.audio ? { audio: t.audio, artist: t.artist || artist, title: title || t.title, cover: t.cover || '' } : null;
    }
    function tip(note) {
      const c = note.cloneNode(true); c.querySelectorAll('.note-play').forEach(n => n.remove());
      const parts = H ? H.noteText(c) : [{ text: 'Luistertip: ' + clean(c.textContent.replace(/^LUISTERTIP/, '')), en: false }];
      // want: what the tip recommends, so Liner can look for a clip itself when the site has none
      return { kind: 'tip', text: say(parts), parts: raw(parts), track: trackFor(note), want: whoOf(note) };
    }
    function quote(q) {
      const span = q.querySelector('span');
      const by = clean(span ? span.textContent : '');
      const c = q.cloneNode(true); c.querySelectorAll('span').forEach(n => n.remove());
      const text = clean(c.textContent).replace(/^["“”']+|["“”']+$/g, '');
      const en = isEnglish(text);
      const byParts = by ? textParts(by) : [];
      return { kind: 'quote', text: en ? text : say([{ text, en: false }]), parts: [{ text, en }], en, by: say(byParts), byParts: raw(byParts) };
    }

    const segs = [];
    const cover = book.querySelector('.opener.cover');
    const kicker = cover && cover.querySelector('.kicker') ? clean(cover.querySelector('.kicker').textContent).split('·').pop().trim() : '';
    const h1 = cover ? clean((cover.querySelector('h1') || {}).textContent) : clean(document.title);
    const sub = cover && cover.querySelector('.sub') ? clean(cover.querySelector('.sub').textContent) : '';
    const sentence = s => /[.?!:]$/.test(s) ? s : s + '.';
    { const tp = textParts([kicker, h1, sub].filter(Boolean).map(sentence).join(' ')); segs.push({ kind: 'title', text: say(tp), parts: raw(tp) }); }

    const handleAside = a => {
      if (a.matches('aside.side-note') && a.querySelector('.who')) segs.push(tip(a));
      else if (a.matches('aside.side-quote')) segs.push(quote(a));
    };
    flow.querySelectorAll(':scope > *').forEach(el => {
      if (el.matches('.opener.part')) {
        const k = el.querySelector('.kicker');
        const side = k ? clean(k.textContent).split('·')[0].trim() : '';
        // heading and subtitle separately, otherwise "popmuziek?Vier" runs together
        const bits = [...el.querySelectorAll('h2, .sub')].map(x => partsOf(x).concat([{ text: /[.?!:]$/.test(clean(x.textContent)) ? ' ' : '. ', en: false }]));
        const pp = [{ text: side ? side + '. ' : '', en: true }].concat(...(bits.length ? bits : [partsOf(el)]));
        segs.push({ kind: 'part', text: say(pp), parts: raw(pp) });
      } else if (el.matches('.head')) {
        const h3 = el.querySelector('h3');
        if (h3) { const hp = partsOf(h3); segs.push({ kind: 'head', text: say(hp), parts: raw(hp) }); }
      } else if (el.matches('p')) {
        const pp = partsOf(el);
        const t = say(pp);
        if (t) segs.push({ kind: 'p', text: t, parts: raw(pp) });
        el.querySelectorAll('aside').forEach(handleAside);
      } else if (el.matches('aside')) handleAside(el);
    });
    return { title: h1, kicker, mixtape: N, lex: { overal, engels }, segs: segs.filter(s => s.text || s.track), cover: cover ? ((cover.style.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/) || [])[1] || '' : '' };
  }

  // ---------- Any other site ----------
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  const skip = 'nav, header nav, footer, form, script, style, noscript, button, [aria-hidden="true"], .cookie, #cookie, [class*="cookie"], [class*="share"], [class*="newsletter"]';
  const h1 = document.querySelector('h1');
  const title = clean(h1 ? h1.innerText : document.title);
  const segs = [{ kind: 'title', text: years(title) + '.' }];
  const seenAudio = new Set();
  root.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, audio').forEach(el => {
    if (el.closest(skip) || el === h1) return;
    if (el.matches('audio')) {
      const src = el.currentSrc || el.getAttribute('src') || (el.querySelector('source[src]') || {}).src;
      if (!src || seenAudio.has(src)) return;
      seenAudio.add(src);
      const label = clean(el.getAttribute('aria-label') || el.title || (el.closest('figure') && el.closest('figure').innerText) || '');
      segs.push({ kind: 'tip', text: label ? 'Luister: ' + label + '.' : '', track: { audio: abs(src), artist: '', title: label } });
      return;
    }
    if (el.matches('p, li') && el.closest('blockquote')) return;
    if (el.matches('li') && el.querySelector('p')) return;
    const t = years(clean(el.innerText));
    if (!t || (el.matches('li') && t.length < 40)) return;
    if (el.matches('h1, h2, h3, h4')) segs.push({ kind: 'head', text: t });
    else if (el.matches('blockquote')) segs.push({ kind: 'quote', text: t, en: /\b(the|you|and|that|was)\b/i.test(t) && !/\b(de|het|een|niet)\b/i.test(t), by: '' });
    else segs.push({ kind: 'p', text: t });
  });
  const og = (document.querySelector('meta[property="og:image"]') || {}).content || '';
  return { title, kicker: '', segs, cover: og ? abs(og) : '' };
}


// Make a page header (such as the mixtape cover) square for a capture.
// Returns the side in pixels, or 0 if the element isn't there.
function squareCover(selector, hide) {
  const c = document.querySelector(selector);
  if (!c) return 0;
  for (const el of document.body.querySelectorAll('*')) if (!el.contains(c) && !c.contains(el)) el.style.setProperty('display', 'none', 'important');
  if (hide) c.querySelectorAll(hide).forEach(el => el.style.setProperty('display', 'none', 'important'));
  let p = c;
  while (p && p !== document.body) { for (const k of ['margin', 'padding']) p.style.setProperty(k, '0', 'important'); p.style.setProperty('max-width', 'none', 'important'); p = p.parentElement; }
  for (const k of ['margin', 'padding']) document.body.style.setProperty(k, '0', 'important');
  const side = Math.min(innerWidth, innerHeight);
  for (const [k, v] of [['width', side + 'px'], ['height', side + 'px'], ['min-height', side + 'px'], ['max-height', side + 'px'], ['position', 'fixed'], ['left', '0'], ['top', '0'], ['margin', '0'], ['box-sizing', 'border-box']]) c.style.setProperty(k, v, 'important');
  scrollTo(0, 0);
  return side;
}

module.exports = {
  squareCoverSource: (selector, hide) => `(${squareCover.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(hide || '')})`,
  scanIndexSource: `(${scanIndex.toString()})()`,
  // fallback: { helper, lex } for sites that no longer serve their own read-aloud files (see sites/)
  extractChapterSource: fallback => `(${extractChapter.toString()})(${JSON.stringify(fallback || null)})`
};
