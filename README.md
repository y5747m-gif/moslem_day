# VocalPure — Download site + standalone Android music player

VocalPure is an Android music player whose exclusive advantage is that it
**removes the music automatically**: an on-device AI engine isolates the
voice of every song while it streams, so the listener only ever hears the
words — in real time, on device, offline, with no mode to choose.

The project has two completely separate parts:

1. **The website** (repo root) — a polished, fully static **download
   interface only**. It introduces the app, shows the real APK metadata
   (version, size, SHA-256, changelog), install guide, QR code, and a
   customizable animated background. **It contains no music player and no
   demo music** — everything playable lives in the app.
2. **The Android app** (`app/` → built into `downloads/*.apk`) — a
   **standalone music player** with its own UI, identity and feature set.
   It does **not** bundle the website: only the `app/` files go into the
   APK.

## The app — features

- **AI voice engine (always on)** — there is exactly one playback path:
  the AI. No mode selector, no stem mixer, no music fader and no karaoke
  export exist anywhere in the app; the listener hears the isolated voice,
  never the instruments.
- **Streamed playback (no more crashes on big files)** — songs are piped
  into the engine through a media element (`blob:` for imported files, the
  Android streaming bridge with real HTTP **range** support for phone-library
  files). Nothing is ever decoded into an `AudioBuffer`, so a two-hour
  recording behaves exactly like a three-minute single. The old engine's
  whole-file `decodeAudioData` + Base64 path — the source of the crash — is
  gone.
- **Live AI panel** — the Now Playing screen shows voice activity, how many
  dB of music were cut, the pitch the engine locked onto, its state and its
  processing latency, updating live while the song plays.
- **Library** — import multiple songs at once (file picker, drag & drop),
  auto-parsed “Artist – Title” names, generated covers, duration, sort by
  title/artist/date, remove. Library (audio included) stored in IndexedDB,
  restored on launch, fully offline.
- **Now-playing screen** — live frequency visualizer, seek bar, prev /
  play / next, shuffle, repeat (off / all / one), playback speed 0.5×–2×,
  volume + mute, sleep timer (15/30/60 min).
- **Search** — instant title/artist filter with match count.
- **Playlists & favorites** — create/rename/delete playlists, star
  favorites; all persisted on-device. **Queue** — live “Up next” list.
- **Separation controls (voice only)** — four strength presets
  (Soft / Balanced / Strong / Max), a voice-boost make-up gain and a
  “silence the music-only parts” gate. None of them can bring the music back.
- **5-band equalizer** — 60 Hz – 14 kHz with presets (Flat, Pop, Rock,
  Jazz, Bass Boost, Vocal Boost, …).
- **WAV export** — the purified voice is **captured from the engine while
  the song plays** and streamed to disk in 1.5 MB chunks (native
  `writeFile(name, base64Chunk, finalChunk)` + `finishWav()` header patch),
  so export memory stays flat no matter how long the track is. Chrome/desktop
  falls back to a blob download.
- **In-app updates** — the app compares its installed version against the
  published `app-info.json` (auto-check on launch + every 30 min + a manual
  **Check** button in Settings) and shows an update banner with one-tap
  download via the native `openUpdatePage()` bridge.
- **Appearance studio** — Settings → Appearance offers a **background
  mode** field (Gradient glow / Minimal flat / My wallpaper), 6 theme
  presets (incl. Light mode), 2 custom accent colors, wallpaper upload with
  visibility control, and reset — saved per device.
- **Offline & private** — no network calls at all after launch (except the
  opt-in update check); songs never leave the device.

## The website — features

- **Download center** — stable + mirror APK cards, live metadata from
  `app-info.json`, SHA-256 display, copy-link button, install guide,
  requirements and changelog, QR code pointing at the APK URL.
- **Live updates for every visitor** — the page re-checks
  `app-info.json` every minute (plus on tab focus/visibility/online) and
  applies new releases automatically with a banner + toast; open tabs
  notify each other via `BroadcastChannel` (localStorage fallback), and a
  manual **Check for updates** button shows the last-check time.
- **Animated background** — drifting gradient orbs, grid glow and an
  interactive canvas particle field; **Background Studio** (bottom-right)
  with a **background-mode** field (Full / Orbs / Particles / Minimal), 6
  theme presets or 3 custom accent colors, particle/speed/glow/hue tuning,
  grid toggle, and wallpaper upload — saved in `localStorage`.
- Responsive, accessible (ARIA, keyboard, `prefers-reduced-motion`).

## Project structure

```
├── index.html              # download site (no player, no demo music)
├── css/style.css           # site theme, layout, animations, responsive
├── js/
│   ├── background.js       # particle engine + Background Studio
│   └── app.js              # site logic: nav, reveal, downloads, QR
├── app-info.json           # release metadata (single source of truth for
│                           # version, sizes, checksums, changelog)
├── app/                    # the STANDALONE app (what the APK contains)
│   ├── index.html          # player shell: library/search/playlists/settings
│   ├── style.css           # its own UI theme (warm amber/coral)
│   ├── app.js              # player: streaming transport, library, AI panel
│   ├── vp-ai-engine.js     # the AI voice engine (AudioWorklet, engine v6)
│   └── app-info.json       # in-APK version/changelog fallback
├── android/                # APK build pipeline (no Android SDK needed)
│   ├── build_apk.py        # aapt2 → javac/dx → zip → v1+v2+v3 signing
│   ├── verify_apk.py       # independent re-implementation of AOSP verifiers
│   ├── bootstrap_tools.sh  # fetches/compiles the toolchain (see BUILDING.md)
│   ├── sync_assets.sh      # bundles app/ (only!) into assets/www
│   └── keystore/           # release signing key (intentionally committed)
├── tools/                  # verification harnesses (not shipped)
│   ├── verify_app.js       # static checks: syntax, DOM contract, metadata
│   ├── test_ai_engine.js   # DSP harness: runs the real worklet in Node
│   └── smoke_app.js        # jsdom functional test + undeclared-symbol scan
└── downloads/
    ├── VocalPure-v2.9.0.apk        # signed stable app (Android 8.0+) — AI voice engine
    ├── VocalPure-v2.8.0.apk        # previous stable (kept for reference)
    └── VocalPure-v2.7.0.apk        # older stable (kept for reference)
```

## Run the website locally

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Any static server works (`npx serve`, Nginx, GitHub Pages, Netlify, …).
The app can also be opened directly in a desktop browser for testing:
`http://localhost:8080/app/`.

## Building the APK

```bash
export VP_TOOLS=$HOME/.vp-tools VP_JAVA=$(python3 -c 'import jdk4py; print(jdk4py.JAVA)')
./android/sync_assets.sh
python3 android/build_apk.py --version-name 2.9.0 --version-code 290 \
    --out downloads/VocalPure-v2.9.0.apk
python3 android/verify_apk.py downloads/VocalPure-v2.9.0.apk
```

One-time toolchain setup (`pip install jdk4py`, then
`./android/bootstrap_tools.sh`) is documented in `android/BUILDING.md`.

After a build, update `app-info.json` (`size`, `sha256`, `updated`,
`changelog`) — the website picks everything up automatically. The APK
bunds its own `app-info.json` (used by the app as a version fallback when
the native bridge is unavailable), while the in-app version labels come
from the native `AppBridge.appInfo()`.

## The AI voice engine (engine v6)

Playback has exactly one route and one destination — the isolated voice:

```
<audio> (stream) → MediaElementSource → AI worklet → voice boost
                → compressor → 5-band EQ → master → speakers
```

`app/vp-ai-engine.js` registers an `AudioWorkletProcessor` (`"vp-ai-voice"`)
that is built from the factory's own source through a `blob:` URL, so it
loads inside the Android WebView from `file://` without a second fetch.
Every 256-sample hop (~5.3 ms) it runs a 1024-point STFT (75 % overlap) and
computes, per frequency bin, a soft mask from several independent cues:

- **online voice/music profiles** — two non-negative spectral bases updated
  multiplicative-per-frame (voice bases learn only from frames the
  modulation gate accepts, so a sustained pad cannot poison the voice
  model); this is the “learning” part — the engine adapts to *this* singer
  on *this* device while the track plays;
- **centre-channel coherence** — vocals are usually centre-locked, measured
  as mid/side coherence per bin (auto-detected mono tracks switch to a
  spectral-only mask);
- **pitch/harmonic tracking** — band-passed (175 Hz–3.4 kHz) decimated
  autocorrelation finds F0 in 65–480 Hz; bins near harmonics of F0 get a
  comb bonus;
- **syllabic modulation** — `|fast − slow| / slow` per bin, which separates
  speech-rate energy from sustained instrumentals;
- **band prior** — steep roll-off below ~90 Hz and above ~9 kHz, where the
  voice carries almost nothing;
- a **VAD** (periodicity + spatial + band focus) that drives a gate so
  music-only sections fall to silence instead of leaking.

The cues are combined in a logit, squashed by a per-preset steepness, gated,
smoothed (3-tap + AR) and floored by the strength preset
(Soft/Balanced/Strong/Max → floor 0.10/0.055/0.030/0.015). The mask is
applied to both channels, the frame is re-packed, inverse-transformed and
overlap-added; added latency is one FFT frame (≈21 ms at 48 kHz).

Live metrics (voice ratio, music-cut dB, F0, clarity, latency) are posted to
the app ~4×/second — that is what the AI panel displays, and the app turns
the metrics into a per-song profile after ~4 s of playback (stored in
IndexedDB, shown as “✓ AI” in the list).

**Fallback**: WebViews without `AudioWorklet` get a real-time filter chain
(mono fold + 145 Hz high-pass + presence shaping) — still voice-only, just
without the adaptive spectral model.

> Note: this is an adaptive spectral-masking separator with online learning,
> not a deep-learning stem model (no weights are downloaded; the APK stays
> ~0.1 MB). Use it only on music you own or have the right to remix.

## Checks run on this repo

```bash
node tools/verify_app.js      # static: syntax, DOM contract, assets, metadata
node tools/test_ai_engine.js  # runs the real worklet source in Node (16 checks)
node tools/smoke_app.js       # jsdom functional test + undeclared-symbol scan
# first time only: npm --prefix tools install
```

- **`verify_app.js`** — all JS parses, HTML tag balance, every `$("id")` the
  app uses exists in `app/index.html`, every local `href`/`src` exists, no
  music/stem control is left in the app, the engine exposes its presets, the
  worklet source compiles, and `app-info.json` size + SHA-256 match the APK
  actually in `downloads/` (bundled `app/app-info.json` version too).
- **`test_ai_engine.js`** — a Node `vm` shim that runs the *real* worklet
  code and asserts the DSP contract: bit-transparent bypass (8.5e-8), music
  removed (−30.5 dB music-only, −21 dB bass, −13 dB hats, silence-only
  intro), voice kept (−2.9 dB), voice/music SNR improved by +6.4 dB, mono
  handling, >8× realtime, and 16-bit PCM capture streaming.
- **`smoke_app.js`** — boots the real app inside jsdom with mocked Web Audio,
  IndexedDB and the Android bridge, then drives it: device scan, streamed
  playback (`blob:` and `vocalpure.local/audio?path=` sources), worklet
  creation + params, live meters, strength/boost/denoise controls, transport,
  search, playlists, EQ, themes, import, oversized-file rejection, capture
  export and library clearing — plus a scope analysis that fails on any
  symbol used but never declared.
- APKs verified with `android/verify_apk.py` (v2/v3 digests + RSA signatures
  + certificate match) **and** androguard (v1+v2+v3 present, manifest fields,
  bundled-asset listing — no website content inside); the file on disk
  matches `app-info.json`.
