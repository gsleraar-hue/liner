# Liner

Liner turns a website into an audiobook: it reads the pages aloud with free Microsoft
neural voices and mixes in the music fragments the text talks about.

It was made for [School of Rock](https://sorock.nl), a Dutch reader on the history of pop
music in thirteen "mixtapes". Every chapter becomes a chapter of the audiobook; wherever the
text recommends a song, you hear a fragment of it, and the song plays quietly under the voice
while the text discusses it.

**The app itself is in Dutch.** It is meant for Dutch-language websites read by Dutch or
Flemish voices. This README and the source code are in English.

## What it does

- **Fetch a site**: enter a web address; Liner finds the pages that look like chapters
  (for School of Rock: the thirteen mixtapes) and lets you choose which ones to include.
- **Voices**: the free neural voices behind "Read aloud" in Microsoft Edge (Dutch:
  Fenna, Colette, Maarten; Flemish: Dena, Arnaud). No API key needed.
- **Pronunciation**: English names and titles are spelled the way a Dutch voice should say
  them, using the site's own pronunciation list plus your own corrections. A pronunciation
  window lets you try a spelling and hear it straight away. Optionally an English voice reads
  English names and titles instead.
- **Music**: the fragment of a recommended song plays where the text recommends it, softly
  underneath the voice while the text discusses it (ducked when the voice speaks), between
  chapters, and as an intro and outro.
- **Cover art**: every chapter gets its own square cover, captured from the chapter's header
  on the site; the whole book gets the cover of the home page.
- **Output**: one `.m4b` audiobook with chapter marks and per-chapter artwork, separate MP3
  files per chapter (each with its own cover), or both.
- **Updates**: the app checks GitHub for a newer version and installs it when you quit.

## Install

Download `Liner-Setup-x.y.z.exe` from the
[latest release](https://github.com/gsleraar-hue/liner/releases/latest) and run it.
Windows only. ffmpeg is included.

The installer is not code-signed, so Windows SmartScreen may warn the first time:
choose *More info* -> *Run anyway*.

## How it works

| Part | File |
| --- | --- |
| Reading pages in a hidden browser window, extracting text, songs and covers | `lib/extract.js` |
| Free Edge voices over their websocket | `lib/edge-tts.js` |
| Which words are English, pronunciation lists | `lib/language.js`, `lib/sites/*.json` |
| Speech, fragments, ducking and mixing to PCM; encoding with ffmpeg | `lib/render.js` |
| Per-chapter artwork in the `.m4b` (Apple-style chapter image track) | `lib/chapter-art.js` |
| Window, settings, updates | `main.js`, `renderer/` |

Site-specific knowledge (which words on School of Rock are English, Dutch band names with
English names, acronyms) lives in `lib/sites/sorock.json`. Other sites fall back to a generic
extractor.

## Develop

```
npm install
npm start
```

- `npm run smoke` renders a preview of one chapter without opening a window
  (`LINER_CH=03` picks a chapter, `LINER_FULL=1` also builds a two-chapter book).
- `npm run dist` builds the installer locally (with `--publish never`).

## Release

1. `npm version 0.5.0 --no-git-tag-version` (keeps package.json and the lock file in step)
2. commit, then `git tag v0.5.0 && git push origin main v0.5.0`

The *Build* workflow builds the installer on Windows and publishes one release with the
installer, its `.blockmap` and `latest.yml`. Installed copies pick it up automatically.

## Notes

- The Edge voice service is free but not an official API; if Microsoft changes it, speech
  may stop working until Liner is updated.
- The music fragments are short previews; the audiobooks are meant for personal and
  classroom use.

## License

MIT
