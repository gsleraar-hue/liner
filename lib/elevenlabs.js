// ElevenLabs text to speech (paid). One multilingual voice reads Dutch and the English names
// and titles in it, so the text goes to the voice as written - no respelling lists needed.
// API: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
const BASE = 'https://api.elevenlabs.io';

class ElevenLabsError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Turn an API error into a sentence the user can act on (the app's text is Dutch).
async function fail(r) {
  let detail = '';
  let status = '';
  try { const j = await r.json(); status = (j.detail && j.detail.status) || ''; detail = (j.detail && (j.detail.message || j.detail.status)) || JSON.stringify(j).slice(0, 200); } catch (e) {}
  // An empty balance also comes back as 401 ("quota_exceeded"), so check that first.
  if (r.status === 402 || /quota|credits/i.test(status + ' ' + detail)) throw new ElevenLabsError('ElevenLabs: je tegoed is op. Wacht tot je tegoed weer wordt aangevuld (gratis account: elke maand), of kies een abonnement op elevenlabs.io. (' + detail + ')', 402);
  // 401 can mean a wrong key, a key without the needed permission ("missing_permissions"), or
  // ElevenLabs blocking free use it finds suspicious ("detected_unusual_activity"): show which.
  if (r.status === 401) {
    const why = /missing_permissions|permission/i.test(detail) ? 'De sleutel mist een recht. Zet bij de sleutel "Text to Speech" op toegang en "Voices" op lezen. '
      : /unusual_activity/i.test(detail) ? 'ElevenLabs blokkeert gratis gebruik vanaf deze verbinding (bijvoorbeeld via VPN). '
      : /invalid_api_key|invalid/i.test(detail) ? 'De sleutel klopt niet. ' : '';
    throw new ElevenLabsError(`ElevenLabs weigert: ${why}(${detail || 'HTTP 401'})`, 401);
  }
  if (r.status === 429) throw new ElevenLabsError('ElevenLabs: te veel tegelijk of te snel, even wachten.', 429);
  throw new ElevenLabsError(`ElevenLabs gaf een fout (HTTP ${r.status}). ${detail}`, r.status);
}

// Models that accept a language code; eleven_multilingual_v2 works it out itself.
const WITH_LANGUAGE = /^eleven_(v3|v4|flash_v2_5|turbo_v2_5)/;

async function synthesizeOnce(text, { key, voiceId, model = 'eleven_v4', rate = 1 }) {
  const body = { text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.min(1.2, Math.max(0.7, rate)) } };
  if (WITH_LANGUAGE.test(model)) body.language_code = 'nl';
  const r = await fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(body)
  });
  if (!r.ok) await fail(r);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new ElevenLabsError('ElevenLabs gaf geen audio terug.');
  return buf;
}

// Retry only what can pass by itself (busy, network); a wrong key or an empty balance stops at once.
async function synthesize(text, opts) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return await synthesizeOnce(text, opts); }
    catch (e) {
      last = e;
      if (e.status && e.status !== 429 && e.status < 500) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

async function listVoices(key) {
  const r = await fetch(`${BASE}/v1/voices`, { headers: { 'xi-api-key': key } });
  if (!r.ok) await fail(r);
  const j = await r.json();
  return (j.voices || []).map(v => ({
    id: v.voice_id,
    name: v.name,
    category: v.category || '',
    labels: v.labels || {},
    languages: (v.verified_languages || []).map(l => l.language || l.locale).filter(Boolean)
  }));
}

async function subscription(key) {
  const r = await fetch(`${BASE}/v1/user/subscription`, { headers: { 'xi-api-key': key } });
  if (!r.ok) await fail(r);
  const j = await r.json();
  return { used: j.character_count, limit: j.character_limit, tier: j.tier, reset: j.next_character_count_reset_unix };
}

module.exports = { synthesize, listVoices, subscription, ElevenLabsError };
