// Image per chapter in an .m4b, the way Apple does it: a (disabled) track of jpegs,
// referenced by the audio track via tref/chap, next to the track with the chapter titles.
// ffmpeg writes the jpeg track itself; only the moov box is adjusted here.
// ffmpeg puts moov after mdat, so moov's size can change without shifting audio offsets.
const fs = require('fs');

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'tref']);

function parse(buf, start, end) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let head = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); head = 16; }
    else if (size === 0) size = end - p;
    if (size < head || p + size > end) throw new Error('Ongeldige box ' + type);
    const box = { type, head: buf.subarray(p, p + head) };
    if (CONTAINERS.has(type)) box.children = parse(buf, p + head, p + size);
    else box.body = buf.subarray(p + head, p + size);
    boxes.push(box);
    p += size;
  }
  return boxes;
}

function serialize(box) {
  const body = box.children ? Buffer.concat(box.children.map(serialize)) : box.body;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(box.type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

const find = (boxes, type) => (boxes || []).find(b => b.type === type);
const handler = trak => { const h = find(find(trak.children, 'mdia').children, 'hdlr'); return h ? h.body.toString('latin1', 8, 12) : ''; };
const trackId = trak => { const t = find(trak.children, 'tkhd').body; return t.readUInt32BE(t[0] === 1 ? 20 : 12); };

function addChapterImages(file) {
  // read only the top-level headers; the audio (mdat) stays on disk
  const length = fs.statSync(file).size;
  const rd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  let p = 0, moovAt = -1, moovSize = 0, buf;
  try {
    while (p + 8 <= length) {
      fs.readSync(rd, head, 0, 16, p);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      else if (size === 0) size = length - p;
      if (size < 8) throw new Error('Ongeldige box ' + type);
      if (type === 'moov') { moovAt = p; moovSize = size; }
      p += size;
    }
    if (moovAt < 0) throw new Error('Geen moov-box gevonden');
    if (moovAt + moovSize !== length) throw new Error('moov staat niet aan het eind; hoofdstukafbeeldingen overgeslagen');
    buf = Buffer.alloc(moovSize);
    fs.readSync(rd, buf, 0, moovSize, moovAt);
  } finally { fs.closeSync(rd); }

  const [moov] = parse(buf, 0, moovSize);
  const traks = moov.children.filter(b => b.type === 'trak');
  const audio = traks.find(t => handler(t) === 'soun');
  const video = traks.find(t => handler(t) === 'vide');
  if (!audio || !video) throw new Error('Geen audio- of beeldspoor');
  const vid = trackId(video);

  // disable the video track (flags 0), so players don't show it as a movie
  const tkhd = find(video.children, 'tkhd');
  tkhd.body = Buffer.from(tkhd.body);
  tkhd.body[1] = 0; tkhd.body[2] = 0; tkhd.body[3] = 0;

  // the video track itself references nothing
  video.children = video.children.filter(b => b.type !== 'tref');

  // sample type 'jpeg' as in Apple audiobooks, instead of 'mp4v' with esds
  const stbl = find(find(find(video.children, 'mdia').children, 'minf').children, 'stbl');
  const stsd = find(stbl.children, 'stsd');
  const sb = stsd.body, entrySize = sb.readUInt32BE(8);
  if (sb.toString('latin1', 12, 16) === 'mp4v') {
    const entry = sb.subarray(8, 8 + entrySize);
    const fixed = Buffer.from(entry.subarray(0, 86));    // header (8) + fixed VisualSampleEntry fields (78)
    fixed.write('jpeg', 4, 'latin1');
    const kids = [];
    for (let q = 86; q + 8 <= entry.length;) { const z = entry.readUInt32BE(q); if (z < 8) break; if (entry.toString('latin1', q + 4, q + 8) !== 'esds') kids.push(entry.subarray(q, q + z)); q += z; }
    const neu = Buffer.concat([fixed, ...kids]);
    neu.writeUInt32BE(neu.length, 0);
    stsd.body = Buffer.concat([sb.subarray(0, 8), neu, sb.subarray(8 + entrySize)]);
  }

  // make the audio track reference the video track as a chapter track
  let tref = find(audio.children, 'tref');
  if (!tref) { tref = { type: 'tref', children: [] }; audio.children.splice(audio.children.indexOf(find(audio.children, 'tkhd')) + 1, 0, tref); }
  let chap = find(tref.children, 'chap');
  if (!chap) { chap = { type: 'chap', body: Buffer.alloc(0) }; tref.children.push(chap); }
  const ids = [];
  for (let i = 0; i + 4 <= chap.body.length; i += 4) ids.push(chap.body.readUInt32BE(i));
  if (!ids.includes(vid)) ids.push(vid);
  chap.body = Buffer.alloc(ids.length * 4);
  ids.forEach((id, i) => chap.body.writeUInt32BE(id, i * 4));

  const newMoov = serialize(moov);
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, newMoov, 0, newMoov.length, moovAt);
    fs.ftruncateSync(fd, moovAt + newMoov.length);
  } finally { fs.closeSync(fd); }
  return { videoTrack: vid, chapterTracks: ids };
}

module.exports = { addChapterImages };
