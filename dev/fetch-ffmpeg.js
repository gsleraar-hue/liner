'use strict';

// Fetches a static ffmpeg binary for a given platform and architecture, so the
// app can ship one instead of asking people to install it themselves.
//
// The builds come from ffmpeg-static, which publishes plain binaries (no
// archive) plus a gzipped variant. Gzip is the only format Node can unpack on
// its own, which keeps this free of extra tooling. The version is pinned so a
// rebuild produces the same app.
//
// Run directly to fetch for this machine: npm run ffmpeg

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const VERSION = 'b6.1.1';
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${VERSION}`;

const CACHE = path.join(__dirname, '..', 'build', 'cache');

function binaryName(platform) {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

// electron-builder calls macOS "darwin" and Windows "win32" in its afterPack
// context, which matches process.platform, so no translation is needed.
async function ensureFfmpeg(platform, arch) {
  const target = path.join(CACHE, `ffmpeg-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`);
  if (fs.existsSync(target) && fs.statSync(target).size > 1024 * 1024) return target;

  const url = `${BASE}/ffmpeg-${platform}-${arch}.gz`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`ffmpeg download failed: ${res.status} ${res.statusText} for ${url}`);
  }

  const gz = Buffer.from(await res.arrayBuffer());
  const raw = zlib.gunzipSync(gz);
  if (raw.length < 1024 * 1024) {
    throw new Error(`ffmpeg download looks truncated: ${raw.length} bytes`);
  }

  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(target, raw);
  fs.chmodSync(target, 0o755);
  return target;
}

// Drops the binary into the packaged app, where main.js looks for it.
async function placeFfmpeg(resourcesDir, platform, arch) {
  const source = await ensureFfmpeg(platform, arch);
  const dir = path.join(resourcesDir, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, binaryName(platform));
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

module.exports = { ensureFfmpeg, placeFfmpeg, binaryName, VERSION };

if (require.main === module) {
  ensureFfmpeg(process.platform, process.arch)
    .then((p) => {
      const mb = (fs.statSync(p).size / 1048576).toFixed(1);
      console.log(`ffmpeg ${VERSION} ready: ${p} (${mb} MB)`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
