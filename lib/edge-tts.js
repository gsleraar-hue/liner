// Free Microsoft voices (the same as "Read aloud" in Edge), via Edge's websocket.
const crypto = require('crypto');
const WebSocket = require('ws');

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM = '143.0.3650.96';
const BASE = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM.split('.')[0]}.0.0.0`,
  'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Pragma': 'no-cache',
  'Cache-Control': 'no-cache'
};

// The service wants a time-bound token; the server's clock is what counts, so remember any skew.
let skew = 0;
function secMsGec() {
  let t = Math.floor(Date.now() / 1000) + skew + 11644473600;
  t -= t % 300;
  return crypto.createHash('sha256').update(`${t * 10000000}${TOKEN}`).digest('hex').toUpperCase();
}
const uuid = () => crypto.randomUUID().replace(/-/g, '');
const stamp = () => new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

async function listVoices() {
  const url = `https://${BASE}/voices/list?trustedclienttoken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error('Stemmenlijst: HTTP ' + r.status);
  return r.json();
}

// One piece of text to mp3 (24 kHz mono). rate: 1 = normal, 1.15 = 15% faster.
function synthesize(text, { voice = 'nl-NL-FennaNeural', rate = 1, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `wss://${BASE}/edge/v1?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM}&ConnectionId=${uuid()}`;
    const ws = new WebSocket(url, { headers: HEADERS });
    const chunks = [];
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch (e) {} err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('Stemdienst reageert niet (time-out)')), timeoutMs);

    ws.on('unexpected-response', (req, res) => {
      // 403 usually means clock skew: adopt the server time and let the caller retry.
      const d = Date.parse(res.headers.date || '');
      if (res.statusCode === 403 && d) skew = Math.round((d - Date.now()) / 1000);
      finish(Object.assign(new Error('Stemdienst weigert verbinding: HTTP ' + res.statusCode), { status: res.statusCode }));
    });
    ws.on('error', e => finish(e));
    ws.on('close', () => finish(new Error('Verbinding met stemdienst gesloten voordat de audio binnen was')));
    ws.on('open', () => {
      ws.send(`X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-96kbitrate-mono-mp3' } } } }));
      const pct = Math.round((rate - 1) * 100);
      const lang = voice.split('-').slice(0, 2).join('-');
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'><prosody pitch='+0Hz' rate='${pct >= 0 ? '+' : ''}${pct}%' volume='+0%'>${xmlEscape(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // 2 bytes header length, then headers, then audio
        const len = data.readUInt16BE(0);
        const head = data.subarray(2, 2 + len).toString();
        if (head.includes('Path:audio')) chunks.push(data.subarray(2 + len));
      } else if (String(data).includes('Path:turn.end')) {
        const buf = Buffer.concat(chunks);
        if (!buf.length) finish(new Error('Stemdienst gaf geen audio terug'));
        else finish(null, buf);
      }
    });
  });
}

async function synthesizeRetry(text, opts, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await synthesize(text, opts); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw last;
}

module.exports = { synthesize: synthesizeRetry, listVoices };
