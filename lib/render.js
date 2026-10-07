// From text segments + clips to audio: make voices, fetch clips, mix, encode.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const tts = require('./edge-tts');

const SR = 44100;            // sample rate of the mix
const BPF = 4;               // bytes per frame: stereo, 16 bit
const f = s => Math.round(s * SR);
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const dbToGain = db => Math.pow(10, db / 20);

class Cancelled extends Error { constructor() { super('Geannuleerd'); this.cancelled = true; } }

class Renderer {
  // elevenlabs: { key, model } when the narrator is an ElevenLabs voice ("el:<voice id>")
  constructor({ ffmpeg, cacheDir, onProgress = () => {}, onLog = () => {}, elevenlabs = null }) {
    this.ffmpeg = ffmpeg;
    this.cache = cacheDir;
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.cancelled = false;
    this.el = elevenlabs;
    this.paidChars = 0;   // characters sent to ElevenLabs in this run (cached speech costs nothing)
    for (const d of ['tts', 'frag', 'pcm']) fs.mkdirSync(path.join(cacheDir, d), { recursive: true });
  }

  cancel() { this.cancelled = true; }
  check() { if (this.cancelled) throw new Cancelled(); }

  run(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.on('error', reject);
      p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg: ' + (err.trim().split('\n').pop() || 'code ' + code))));
    });
  }

  // Each sound is converted once to raw 44.1 kHz stereo; loudness is measured for even volume.
  async decode(src, key, af) {
    const out = path.join(this.cache, 'pcm', key + '.pcm');
    const metaFile = out + '.json';
    if (fs.existsSync(metaFile) && fs.existsSync(out)) return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    await this.run(['-i', src, '-vn', ...(af ? ['-af', af] : []), '-ac', '2', '-ar', String(SR), '-f', 's16le', out]);
    const buf = fs.readFileSync(out);
    let sum = 0, n = 0;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const v = buf.readInt16LE(i) / 32768;
      if (Math.abs(v) > 0.01) { sum += v * v; n++; }   // silences don't count
    }
    const rmsDb = n ? 10 * Math.log10(sum / n) : -60;
    const meta = { path: out, frames: Math.floor(buf.length / BPF), rmsDb };
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    return meta;
  }

  // trim: cut silence at start and end, so Dutch and English parts join up tightly
  async speech(text, voice, rate, trim) {
    const paid = voice.startsWith('el:');
    const key = sha(paid ? `${voice}|${this.el && this.el.model}|${rate}|${text}` : `${voice}|${rate}|${text}`);
    const mp3 = path.join(this.cache, 'tts', key + '.mp3');
    if (!fs.existsSync(mp3)) {
      let buf;
      if (paid) {
        if (!this.el || !this.el.key) throw new Error('Geen ElevenLabs-sleutel ingesteld.');
        buf = await require('./elevenlabs').synthesize(text, { key: this.el.key, voiceId: voice.slice(3), model: this.el.model, rate });
        this.paidChars += text.length;
      } else buf = await tts.synthesize(text, { voice, rate });
      fs.writeFileSync(mp3, buf);
    }
    const c = trim
      ? await this.decode(mp3, 'vt' + key, 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse')
      : await this.decode(mp3, 'v' + key);
    return { ...c, gain: dbToGain(-19 - c.rmsDb) };
  }

  async fragment(url) {
    const key = sha(url);
    const file = path.join(this.cache, 'frag', key);
    if (!fs.existsSync(file)) {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`Fragment niet op te halen (HTTP ${r.status})`);
      fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
      fs.renameSync(file + '.part', file);
    }
    const c = await this.decode(file, 'f' + key);
    return { ...c, gain: dbToGain(-21 - c.rmsDb) };
  }

  // Long paragraphs split into pieces the voice service can handle, cut at sentences.
  static chunks(text, max = 1200) {
    if (text.length <= max) return [text];
    const out = []; let cur = '';
    for (const s of text.split(/(?<=[.!?;:])\s+/)) {
      if ((cur + ' ' + s).length > max && cur) { out.push(cur); cur = s; } else cur = cur ? cur + ' ' + s : s;
    }
    if (cur) out.push(cur);
    return out;
  }

  // Prepare all voices and clips of a chapter up front, a few at a time.
  async prepare(jobs, label) {
    let done = 0;
    const results = new Map();
    const queue = [...jobs];
    let fatal = null;
    const worker = async () => {
      while (queue.length && !fatal) {
        this.check();
        const job = queue.shift();
        try { results.set(job.id, await job.run()); }
        catch (e) {
          // a wrong key or an empty balance would leave the whole book silent: stop at once
          if (e.status === 401 || e.status === 402) { fatal = e; break; }
          this.onLog(`Overgeslagen (${job.what}): ${e.message}`); results.set(job.id, null);
        }
        done++;
        this.onProgress({ phase: label, done, total: jobs.length });
      }
    };
    // ElevenLabs allows only a few requests at a time (2 on the free plan)
    await Promise.all(Array.from({ length: this.el ? 2 : 4 }, worker));
    if (fatal) throw fatal;
    this.check();
    return results;
  }

  // Timeline of one chapter. opts: see DEFAULTS in main.js.
  async plan(ch, opts, { first, last, book, limitSec }) {
    const V = opts.voice, VE = opts.voiceEn, R = opts.rate;
    const jobs = [];
    // English names and titles in an English voice: split the sentence, the right voice per piece.
    const mixed = opts.englishVoice && ch.lang;
    const VN = opts.voiceNames;
    const speakParts = (id, parts, text, voice) => {
      const rs = mixed && parts ? ch.lang(parts) : null;
      if (!rs || !rs.some(r => r.en)) return speak(id, text, voice);
      jobs.push({ id, what: 'stem', run: async () => {
        const out = [];
        for (let k = 0; k < rs.length; k++) {
          const r = rs[k], next = rs[k + 1];
          const end = r.text.trimEnd().slice(-1), nextStart = next ? next.text.trimStart()[0] : '';
          const gap = /[.!?]/.test(end) ? 0.4 : (/[,;:]/.test(end) || /[,;:]/.test(nextStart || '')) ? 0.18 : /[("“]/.test(end + (nextStart || '')) ? 0.1 : 0.05;
          let say = r.text.replace(/^[\s,.;:!?)\]"'’”–-]+/u, '').trim();
          // if the piece ends mid-sentence, add a comma: the voice then keeps 'going'
          // instead of dropping as if the sentence is finished (the comma's pause gets trimmed off)
          if (opts.flow !== false && next && /[\p{L}\d'’)]$/u.test(say)) say += ',';
          if (!/[\p{L}\d]/u.test(say)) { if (out.length) out[out.length - 1].gap = Math.max(out[out.length - 1].gap, gap); continue; }
          const cs = Renderer.chunks(say);
          for (let j = 0; j < cs.length; j++) out.push({ ...(await this.speech(cs[j], r.en ? VN : voice, R, true)), gap: j < cs.length - 1 ? 0.3 : gap });
        }
        return out;
      } });
    };
    const speak = (id, text, voice) => { if (text) jobs.push({ id, what: 'stem', run: async () => { const parts = []; for (const c of Renderer.chunks(text)) parts.push(await this.speech(c, voice, R)); return parts; } }); };
    const frags = new Map();
    const frag = url => { if (url && !frags.has(url)) { frags.set(url, 'F' + frags.size); jobs.push({ id: 'F' + (frags.size - 1), what: 'fragment', run: () => this.fragment(url) }); } return frags.get(url); };

    let segs = ch.segs.filter(s => !(s.kind === 'quote' && !opts.quotes));
    if (limitSec) {
      // A preview only makes the speech it plays: about 15 characters a second, but always up to
      // and including the first tip with a clip. (It used to make the first 40 pieces whatever their
      // length, which costs real credits with a paid voice.)
      const budget = limitSec * 15;
      const firstTip = segs.findIndex(s => s.kind === 'tip' && s.track && s.track.audio);
      let chars = 0, k = 0;
      for (; k < segs.length; k++) {
        chars += (segs[k].text || '').length + (segs[k].by || '').length;
        if (chars > budget && (firstTip < 0 || k >= firstTip)) { k++; break; }
      }
      segs = segs.slice(0, Math.max(k, 2));
    }
    const tips = segs.filter(s => s.kind === 'tip' && s.track && s.track.audio);
    const music = opts.fragments || opts.bed || opts.transitions || opts.introOutro;

    const openText = [first && opts.introOutro ? book.introText : '', ch.titleText || segs[0].text].filter(Boolean).join(' ');
    const openParts = segs[0].parts ? [...(first && opts.introOutro ? [{ text: book.introText + ' ', en: false }] : []), ...segs[0].parts] : null;
    speakParts('open', openParts, openText, V);
    segs.forEach((s, i) => {
      if (s.kind === 'title') return;
      if (s.kind === 'quote') { if (s.en) speak('q' + i, s.text, VE); else speakParts('q' + i, s.parts, s.text, V); speakParts('b' + i, s.byParts, s.by, V); }
      else if (s.kind === 'tip') { if (opts.tipsRead) speakParts('s' + i, s.parts, s.text, V); }
      else speakParts('s' + i, s.parts, s.text, V);
      if (s.kind === 'tip' && s.track && music) frag(s.track.audio);
    });
    const openMusic = music && tips.length ? frag(tips[0].track.audio) : null;
    const closeMusic = music && tips.length ? frag(tips[tips.length - 1].track.audio) : null;
    if (last && opts.introOutro) speakParts('close', [{ text: book.outroText, en: false }], book.outroText, V);

    const res = await this.prepare(jobs, 'stemmen en muziek');
    const get = id => res.get(id) || null;

    const events = [];           // { clip, start, offset, length, gain, fadeIn, fadeOut, duck }
    const voice = [];            // [start, end] of everything spoken
    let t = 0;
    const say = (id, at) => {
      const parts = get(id); if (!parts) return at;
      for (const c of parts) { events.push({ kind: 'stem', clip: c, start: at, offset: 0, length: c.frames, gain: c.gain }); voice.push([at, at + c.frames]); at += c.frames + f(c.gap ?? 0.08); }
      return at;
    };
    const mlen = (c, want) => Math.min(c.frames, want);

    // Opening: music, the title over it after 2.5 s, then fade out.
    const om = openMusic && (opts.transitions || (first && opts.introOutro)) ? get(openMusic) : null;
    if (om) {
      const vStart = f(2.5);
      const vEnd = say('open', vStart);
      const len = mlen(om, vEnd + f(2.5));
      events.push({ kind: 'opening', clip: om, start: 0, offset: 0, length: len, gain: om.gain * 0.9, fadeIn: f(0.05), fadeOut: f(3), duck: true });
      t = Math.max(vEnd, len) + f(0.6);
    } else {
      t = say('open', 0) + f(1.0);
    }

    // Body. Track where music under the voice may go: per section, interrupted by clips.
    // First: which listening tips (with a clip) belong to which section.
    const tipList = [];          // { idx, section, id }
    { let sec = 0; segs.forEach((s, i) => { if (s.kind === 'head' || s.kind === 'part') sec++; else if (s.kind === 'tip' && s.track && frags.has(s.track.audio)) tipList.push({ idx: i, section: sec, id: frags.get(s.track.audio) }); }); }
    const firstFragIdx = opts.fragments && tipList.length ? tipList[0].idx : -1;
    const runs = []; let run = null; let section = 0;
    const endRun = () => { if (run) { run.end = t; runs.push(run); run = null; } };
    const startRun = idx => { if (!run) run = { start: t, section, idx }; };

    for (let i = 0; i < segs.length; i++) {
      this.check();
      const s = segs[i];
      // preview: up to the time limit, but always through the first clip (at most 5 minutes)
      if (limitSec && t > f(limitSec) && (i > firstFragIdx || t > f(300))) break;
      if (s.kind === 'title') continue;
      if (s.kind === 'head' || s.kind === 'part') {
        endRun(); section++;
        t += f(s.kind === 'part' ? 1.0 : 0.6);
        startRun(i); t = say('s' + i, t) + f(0.7);
      } else if (s.kind === 'p') {
        startRun(i); t = say('s' + i, t) + f(0.5);
      } else if (s.kind === 'quote') {
        startRun(i); t = say('q' + i, t) + f(0.35); t = say('b' + i, t) + f(0.6);
      } else if (s.kind === 'tip') {
        const fid = s.track ? frags.get(s.track.audio) : null;
        if (opts.tipsRead) { startRun(i); t = say('s' + i, t) + f(0.4); }
        const c = fid && opts.fragments ? get(fid) : null;
        if (c) {
          endRun();
          const len = mlen(c, f(opts.fragLen));
          events.push({ kind: 'fragment', clip: c, start: t, offset: 0, length: len, gain: c.gain, fadeIn: f(0.02), fadeOut: f(Math.min(2.5, opts.fragLen / 4)) });
          t += len + f(0.8);
        }
      }
    }
    endRun();

    // Softly under the voice: the track this section is about, looped with crossfades.
    if (opts.bed) {
      for (const r of runs) {
        const pick = tipList.find(x => x.section === r.section && x.idx >= r.idx) || [...tipList].reverse().find(x => x.section === r.section && x.idx < r.idx);
        const c = pick && get(pick.id);
        if (!c || c.frames < f(6) || r.end - r.start < f(4)) continue;
        const xf = f(1.5), end = r.end + f(0.4);
        // don't give away the part that plays later as the clip
        const off = c.frames > f(opts.fragLen + 20) ? f(opts.fragLen) : 0;
        let pos = r.start, firstLoop = true;
        while (pos < end - xf) {
          const len = Math.min(c.frames - off, end - pos);
          events.push({ kind: 'eronder', clip: c, start: pos, offset: off, length: len, gain: c.gain * opts.bedVolume * 1.75, fadeIn: firstLoop ? f(2) : xf, fadeOut: Math.min(xf, len / 2), duck: true });
          firstLoop = false;
          pos += len - xf;
        }
      }
    }

    // Ending: the tail of the last track, or the outro of the whole book.
    if (!limitSec) {
      const cm = closeMusic ? get(closeMusic) : null;
      if (last && opts.introOutro && get('close')) {
        t += f(0.6);
        const vStart = t + f(2);
        const vEnd = say('close', vStart);
        if (cm) { const len = mlen(cm, vEnd - t + f(4)); events.push({ kind: 'outro', clip: cm, start: t, offset: Math.max(0, cm.frames - len), length: len, gain: cm.gain * 0.9, fadeIn: f(1), fadeOut: f(4), duck: true }); t += len; }
        else t = vEnd;
      } else if (cm && opts.transitions) {
        t += f(0.3);
        const len = mlen(cm, f(8));
        events.push({ kind: 'staart', clip: cm, start: t, offset: Math.max(0, cm.frames - len - f(1)), length: len, gain: cm.gain * 0.9, fadeIn: f(1), fadeOut: f(4) });
        t += len;
      }
    }
    t += f(1.2);
    return { events, voice, frames: t };
  }

  // Sum everything into one raw file, block by block, with ducking and a soft limiter.
  async mix(plan, outPcm, label) {
    const { events, frames } = plan;
    events.sort((a, b) => a.start - b.start);
    // Merge speech when the pause is short, so the music doesn't bob up and down with every sentence.
    const spans = [];
    for (const [s, e] of [...plan.voice].sort((a, b) => a[0] - b[0])) {
      const l = spans[spans.length - 1];
      if (l && s - l[1] < f(1.2)) l[1] = Math.max(l[1], e); else spans.push([s, e]);
    }
    const DUCK = 0.2, ATT = f(0.3), REL = f(0.7);
    const fds = new Map();
    const fd = p => { if (!fds.has(p)) fds.set(p, fs.openSync(p, 'r')); return fds.get(p); };
    const out = fs.openSync(outPcm, 'w');
    const B = SR;
    const mixBuf = new Float32Array(B * 2);
    const env = new Float32Array(B);
    const raw = Buffer.alloc(B * BPF);
    const outBuf = Buffer.alloc(B * BPF);
    let ei = 0, active = [], si = 0;
    try {
      for (let b0 = 0; b0 < frames; b0 += B) {
        if ((b0 / B) % 20 === 0) { this.check(); this.onProgress({ phase: label, done: b0, total: frames }); await new Promise(r => setImmediate(r)); }
        const n = Math.min(B, frames - b0), b1 = b0 + n;
        mixBuf.fill(0, 0, n * 2);
        // ducking curve for this block
        env.fill(1, 0, n);
        while (si < spans.length && spans[si][1] + REL < b0) si++;
        for (let k = si; k < spans.length && spans[k][0] - ATT < b1; k++) {
          const [s, e] = spans[k];
          for (let i = Math.max(0, s - ATT - b0); i < Math.min(n, e + REL - b0); i++) {
            const x = b0 + i;
            const v = x < s ? 1 - (1 - DUCK) * ((x - (s - ATT)) / ATT) : x <= e ? DUCK : DUCK + (1 - DUCK) * ((x - e) / REL);
            if (v < env[i]) env[i] = v;
          }
        }
        while (ei < events.length && events[ei].start < b1) active.push(events[ei++]);
        active = active.filter(ev => ev.start + ev.length > b0);
        for (const ev of active) {
          const s0 = Math.max(b0, ev.start), s1 = Math.min(b1, ev.start + ev.length);
          if (s1 <= s0) continue;
          const cnt = s1 - s0;
          const got = fs.readSync(fd(ev.clip.path), raw, 0, cnt * BPF, (ev.offset + s0 - ev.start) * BPF);
          const fin = ev.fadeIn || 0, fout = ev.fadeOut || 0;
          for (let i = 0; i < Math.floor(got / BPF); i++) {
            const pos = s0 - ev.start + i;
            let g = ev.gain;
            if (fin && pos < fin) g *= pos / fin;
            if (fout && pos > ev.length - fout) g *= Math.max(0, (ev.length - pos) / fout);
            if (ev.duck) g *= env[s0 - b0 + i];
            const o = (s0 - b0 + i) * 2;
            mixBuf[o] += raw.readInt16LE(i * 4) / 32768 * g;
            mixBuf[o + 1] += raw.readInt16LE(i * 4 + 2) / 32768 * g;
          }
        }
        for (let i = 0; i < n * 2; i++) {
          let x = mixBuf[i];
          const a = Math.abs(x);
          if (a > 0.8) x = Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
          outBuf.writeInt16LE(Math.round(x * 32767), i * 2);
        }
        fs.writeSync(out, outBuf, 0, n * BPF);
      }
    } finally {
      fs.closeSync(out);
      for (const d of fds.values()) fs.closeSync(d);
    }
    return frames;
  }

  async encode(pcm, out, { format, meta = {}, cover }) {
    const args = ['-f', 's16le', '-ar', String(SR), '-ac', '2', '-i', pcm];
    if (format === 'mp3') {
      if (cover) args.push('-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-id3v2_version', '3');
      args.push('-c:a', 'libmp3lame', '-b:a', '160k');
    } else {
      args.push('-c:a', 'aac', '-b:a', '128k');
    }
    for (const [k, v] of Object.entries(meta)) if (v) args.push('-metadata', `${k}=${v}`);
    args.push(out);
    await this.run(args);
  }

  // Join the chapter m4a's into one audiobook with chapter markers.
  async m4b(parts, out, { title, author, cover, tmp }) {
    const list = path.join(tmp, 'concat.txt');
    fs.writeFileSync(list, parts.map(p => `file '${p.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const esc = s => String(s || '').replace(/([=;#\\\n])/g, '\\$1');
    let ms = 0;
    let meta = `;FFMETADATA1\ntitle=${esc(title)}\nartist=${esc(author)}\nalbum=${esc(title)}\ngenre=Audiobook\n`;
    for (const p of parts) {
      const d = Math.round(p.frames / SR * 1000);
      meta += `\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${ms}\nEND=${ms + d}\ntitle=${esc(p.title)}\n`;
      ms += d;
    }
    const metaFile = path.join(tmp, 'chapters.txt');
    fs.writeFileSync(metaFile, meta);
    const q = f => `'${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    const args = ['-f', 'concat', '-safe', '0', '-i', list, '-i', metaFile];
    const maps = ['-map', '0:a'];
    let n = 2;
    // Image per chapter: a video track that shows each picture for exactly as long as its chapter lasts.
    const art = parts.some(p => p.cover);
    if (art) {
      let last = cover;
      const imgs = parts.map(p => (last = p.cover || last));
      if (imgs.every(Boolean)) {
        const lines = ['ffconcat version 1.0'];
        parts.forEach((p, i) => lines.push(`file ${q(imgs[i])}`, `duration ${(p.frames / SR).toFixed(3)}`));
        lines.push(`file ${q(imgs[imgs.length - 1])}`);
        const imgList = path.join(tmp, 'images.txt');
        fs.writeFileSync(imgList, lines.join('\n'));
        args.push('-f', 'concat', '-safe', '0', '-i', imgList);
        maps.push('-map', `${n++}:v`);
      }
    }
    const withArt = maps.length > 2;
    if (cover) { args.push('-i', cover); maps.push('-map', `${n++}:v`); }
    args.push(...maps);
    if (withArt) args.push('-c:v:0', 'mjpeg', '-q:v:0', '3', '-filter:v:0', 'scale=800:800', '-fps_mode', 'passthrough');
    if (cover) args.push(`-c:v:${withArt ? 1 : 0}`, 'mjpeg', `-disposition:v:${withArt ? 1 : 0}`, 'attached_pic');
    args.push('-map_metadata', '1', '-map_chapters', '1', '-c:a', 'copy', '-f', 'mp4', out);
    await this.run(args);
    if (withArt) {
      try { require('./chapter-art').addChapterImages(out); }
      catch (e) { this.onLog('Hoofdstukafbeeldingen niet gelukt: ' + e.message); }
    }
  }

  async coverJpg(url, out) {
    const src = out + '.src';
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.writeFileSync(src, Buffer.from(await r.arrayBuffer()));
    await this.run(['-i', src, '-vf', "scale='if(gt(iw,ih),-2,800)':'if(gt(iw,ih),800,-2)',crop=min(iw\\,ih):min(iw\\,ih)", '-frames:v', '1', '-q:v', '3', out]);
    return out;
  }
}

module.exports = { Renderer, Cancelled, SR };
