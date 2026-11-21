# Tunescribe

Turn audio into sheet music in the browser. Upload a song or record from the microphone, and Tunescribe finds the notes, detects the key and tempo, draws the sheet music, and lets you edit, play back and export.

## Features

- **Inputs:** audio files (MP3, WAV, M4A, OGG, FLAC, or video files with sound), microphone recording, and a built-in demo.
- **Two transcription engines:**
  - **AI:** Spotify's open-source [Basic Pitch](https://github.com/spotify/basic-pitch) neural network. It handles chords, so use it for piano, guitar and full mixes. It loads from a CDN the first time.
  - **Melody:** a built-in YIN pitch tracker for one note at a time (singing, flute, violin and so on). It's fast and works offline. It also takes over automatically if the AI model can't load.
- **Sheet music:** grand staff (with an adjustable hand split), treble clef, bass clef or automatic. Key and tempo are detected automatically. You can change the time signature, rhythm grid, tempo (with tap tempo) and where beat 1 starts.
- **Piano roll editor:** select, drag, resize, add (double-click) and delete notes. Arrow keys move notes, undo/redo is supported, and clicking a key previews its sound.
- **Playback:** a real recorded concert grand piano (Salamander Grand Piano samples, with natural key release and light room reverb), a simple synth, and/or the original recording, at 0.5×–1.5× speed. The piano samples (about 3 MB) are fetched once by the Worker and then served from your R2 bucket (`samples/`).
- **Tidy notes:** one click removes stray or ghost notes, lines notes up with the beat, and switches to an 8th-note grid for cleaner sheet music. Undo reverses it.
- **Exports:** MusicXML (MuseScore, Sibelius, Finale, Dorico), MIDI (any DAW), and PDF through the browser's print dialog.
- **Cloud library (Cloudflare R2):** the original audio and every transcription are saved on the server automatically, including each edit. You see the same library on every device and can play the original audio again later. A backup copy is also kept in the browser.
- **Optional password:** set an `APP_PASSWORD` secret and the whole app asks for it.

## How it works

```
Browser (public/)                      Cloudflare Worker (src/worker.js)        R2 bucket
- finds notes (AI / melody)   ──API──▶  /api/transcriptions  (list/get/put/del)  t/<id>.json
- editor, playback, exports             /api/audio/<id>      (put/get/del)       a/<id>
```

Note detection still runs in the browser. The AI model needs more processing power than a Worker allows, and running it locally keeps the server free and fast. The Worker handles storage, the library and the password.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server status, and whether a password is required |
| POST | `/api/login` | Check the password (sent in the `X-App-Password` header) |
| GET | `/api/transcriptions` | List saved transcriptions |
| GET/PUT/DELETE | `/api/transcriptions/:id` | Read, save or delete one (DELETE also removes its audio) |
| GET | `/api/samples/:file` | Grand-piano samples, cached in R2 (public) |
| GET/PUT/DELETE | `/api/audio/:id` | Original audio file (max 95 MB, supports Range requests) |

## Project layout

```
public/
  index.html          page and layout
  styles.css          styling
  js/app.js           UI, library, recording, wiring
  js/api.js           client for the Worker API
  js/transcribe.js    Basic Pitch (AI) and YIN (melody) engines
  js/music.js         key/tempo detection, quantizing, MusicXML and MIDI writers
  js/pianoroll.js     canvas piano-roll editor
  js/player.js        Web Audio playback
  _headers            security/cache headers for Cloudflare
src/worker.js         Worker: API + R2 storage, serves public/
wrangler.jsonc        Cloudflare config (assets + R2 binding)
test/music.test.mjs   quick Node test of the music engine
```

## Deploy to Cloudflare

### 1. Create the R2 bucket (one time)

In the Cloudflare dashboard, go to **R2 Object Storage → Create bucket** and name it **`tunescribe-files`**. You may need to enable R2 on your account first. It has a free tier.

Or from a terminal: `npx wrangler r2 bucket create tunescribe-files`

If you use a different name, change `bucket_name` in `wrangler.jsonc` to match.

### 2. Deploy from GitHub

1. Create a new GitHub repository and upload everything in this folder (keep the structure: `public/`, `src/`, `wrangler.jsonc`, `package.json`).
2. In Cloudflare, go to **Workers & Pages → Create → Import a repository** and pick the repo.
3. Leave the build command empty. The deploy command is `npx wrangler deploy`.
4. Click **Deploy**. The app will be at `https://tunescribe.<your-subdomain>.workers.dev`, and every push to `main` redeploys it.

### 3. (Optional) Add a password

In your Worker, go to **Settings → Variables and Secrets → Add**. Choose type **Secret**, name it `APP_PASSWORD`, enter a value, and deploy.
Or from a terminal: `npx wrangler secret put APP_PASSWORD`

Without it, anyone with the link can use the app and see or delete the library.

### Run locally

```bash
npm install
npx wrangler dev        # uses a local, simulated R2 bucket
```

If you only open `public/` with a plain static server, the app still works in "Local only" mode and saves in the browser.

## Tips for better results

- Pick the right instrument. It chooses the engine and the staff layout.
- If the sheet music looks messy, fix the **tempo** first (try **Tap**), then **Beat 1 starts at**, then use a coarser **Rhythm grid**.
- Lower the sensitivity if you see lots of tiny extra notes. Raise it if notes are missing.

## Third-party libraries and sounds

- Piano: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm (CC-BY 3.0), MP3s from the Tone.js mirror

- [@spotify/basic-pitch](https://github.com/spotify/basic-pitch-ts) (Apache-2.0): from esm.sh and jsDelivr
- [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org) (BSD-3-Clause): from jsDelivr

To self-host them instead, download the files and change the URLs at the top of `public/js/transcribe.js` and in `public/index.html`.
