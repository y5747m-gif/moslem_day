# VocalPure — Download Website + Standalone Music Player App

This repository holds **two deliberately separate products**:

1. **The website** (`index.html` + `css/` + `js/`) — a pure **download
   interface** for the VocalPure APK. It markets the app, shows
   screenshots, and serves the signed APK with checksums and a QR
   code. It contains **no player and no audio code**.

2. **The Android app** (`app/`) — a complete, standalone music player
   (Lark-Player-style) that ships inside the APK and shares **no code
   or styling with the website**. Its exclusive feature: it splits
   every song into two tracks — 🎤 **Vocals** and 🎶 **Music** — live,
   on-device, while the song plays.

## The app (`app/`)

A self-contained mobile web application bundled into the WebView host
(`android/`) and installed as a normal Android app:

- **Library** — songs, artists, playlists and favorites with search,
  sorting, multi-file import (batch picking on Android), and on-device
  persistence (IndexedDB). Your library survives restarts, fully
  offline.
- **Transport** — play/pause/next/prev, seek, volume + mute,
  shuffle & repeat (off/all/one), playback speed (0.5×–2×), sleep
  timer (time or end-of-track), up-next queue with "play next", and a
  persistent mini-player.
- **Two-track splitter** — every song is separated into a vocal stem
  and a music stem with a live mixer: per-stem level, mute and solo,
  level meters, and one-tap presets: *Original / 🎤 Vocals only /
  🎶 Karaoke / 🎚 My mix*.
- **5-band equalizer** — 60 Hz–14 kHz with presets (Pop, Rock, Jazz,
  Bass Boost, Vocal Boost, …), applied to everything you hear.
- **WAV export** — render vocals-only, karaoke or your custom mix to
  a `.wav` file; on Android it is written straight to the app's Music
  folder through the native bridge (no permissions needed).
- **Android integration** — multi-select audio picker, keep-screen-on
  while playing, hardware back button closes overlays one by one
  (hash-based history), and in-app version info via the
  `VocalPureAndroid` JS bridge.
- **No demo music** — the app ships zero bundled songs and generates
  no synthetic demo tracks. It plays *your* music and nothing else.

## The isolation engine (`app/js/isolation.js`)

Version 3 of the engine is a **crossover-coherent** design, rebuilt
from scratch and verified numerically (`tools/checks/`):

* **Stereo songs** — a Linkwitz-Riley-style 3-way crossover splits
  the mix into low (< 130 Hz), mid (130 Hz–9 kHz) and high (> 9 kHz)
  bands. Only the **mid band** gets center-channel removal:
  `BP(L) − g·BP(mid)` / `BP(R) − g·BP(mid)`, where the two band-passes
  use *identical* filters, so the subtraction is phase-coherent. Bass
  and the top octave pass untouched — the accompaniment no longer
  sounds thin and phasey. At g = 1 the mid band is mathematically the
  side signal.
* **Mono / fake-stereo songs** — the engine measures L/R correlation;
  twin-channel files fall back to the mono path automatically (the
  old engine went silent on them). Mono gets the same 3-way bank with
  an attenuated mid band: `low + (1−g)·mid + high` — smooth, with no
  spectral hole, and cancellation reaching sibilance up to 9 kHz.
* **Adjustable strength** — g is a live GainNode (0–100%), so you can
  dial from "gentle" to "full karaoke" while music plays.
* **Vocal stem** — band-limited mid (100 Hz–10.5 kHz, 24 dB/oct
  edges) with warmth (~210 Hz) and presence (~2.9 kHz) lifts.
* Why the crossover? Subtracting a *filtered* mid from the *raw* mix
  suffers filter phase rotation at the band edges and can actually
  **amplify** the voice there — the numeric test suite caught exactly
  this during development. Applying the removal between
  identically-filtered signals eliminates the problem and keeps the
  three-band sum flat.

Measured against the old site engine on a synthetic song
(`tools/checks/test_isolation.mjs`): −15.3 dB full-band voice
suppression (old: −10.5 dB), bass retention −0.6 dB (old: −1.6 dB),
centered 11 kHz content preserved to −2.0 dB (old: −81.7 dB), mono
voice suppression −13.1 dB (old: −5.4 dB), and g = 1 removes the
core band by −40 dB.

## The website

- **Eye-catching design** — deep black-blue canvas with purple/blue
  gradients, glassmorphism cards and animated phone mockups.
- **Moving background** — drifting gradient orbs, grid glow and an
  interactive canvas particle field with constellation links.
- **Background Studio** (paint-palette button, bottom-right) — six
  theme presets, custom accent colors, animation toggles, particle
  controls and your own wallpaper image, all saved in `localStorage`.
- **Download center** — release card with live version/size/checksum
  from `app-info.json`, copy-link, SHA-256 display, install guide,
  QR code, requirements and changelog.
- **Mobile-friendly** — responsive layout, hamburger menu,
  `prefers-reduced-motion` support, accessible semantics.
- The site **never plays or processes audio** — the player lives only
  in the app. The FAQ says so explicitly.

## Project structure

```
├── index.html              # the website — download interface only
├── css/style.css           # site theme, layout, mockups, animations
├── js/
│   ├── background.js       # particle engine + Background Studio
│   └── site.js             # nav, reveal, release info, download card
├── app-info.json           # release metadata (single source of truth)
├── app/                    # THE ANDROID APP (standalone player)
│   ├── index.html          # app shell: library, split, EQ, queue, settings
│   ├── css/app.css         # app design (charcoal + green/sky — distinct)
│   └── js/
│       ├── isolation.js    # v3 two-stem separation engine
│       └── player.js       # full player logic (no website dependencies)
├── android/                # APK build pipeline (no Android SDK needed)
│   ├── build_apk.py        # aapt2 → javac/dx → zip → v1+v2+v3 signing
│   ├── verify_apk.py       # independent re-implementation of AOSP verifiers
│   ├── bootstrap_tools.sh  # fetches/compiles the toolchain (see BUILDING.md)
│   ├── sync_assets.sh      # bundles ONLY app/ into assets/www
│   ├── src/…/MainActivity.java  # WebView host + file picker + save bridge
│   └── keystore/           # release signing key (see keystore/README.md)
├── tools/checks/           # numeric isolation test + app smoke tests
└── downloads/
    └── VocalPure-v3.0.0.apk  # signed, installable app (Android 8.0+)
```

## Run the website locally

```bash
cd moslem_day
python3 -m http.server 8080
# open http://localhost:8080 — download page only (no player)
```

## Build the APK

```bash
export VP_TOOLS=$HOME/.cache/vp-tools VP_JAVA=$(python3 -c 'import jdk4py; print(jdk4py.JAVA)')
./android/sync_assets.sh
python3 android/build_apk.py --version-name 3.0.0 --version-code 300 \
    --out downloads/VocalPure-v3.0.0.apk
python3 android/verify_apk.py downloads/VocalPure-v3.0.0.apk
```

Then update `app-info.json` (`size`, `sha256`, `updated`, `changelog`) —
the website picks everything up automatically. The app itself needs no
`app-info.json`: its version label comes from the native bridge.

One-time toolchain setup (`pip install jdk4py`, then
`./android/bootstrap_tools.sh`) is documented in `android/BUILDING.md`.

## Checks run on this repo

```bash
node tools/checks/test_isolation.mjs   # numeric DSP verification (18 checks)
tools/checks/run_all.sh               # everything below
```

- `node --check` on every JS bundle.
- HTML tag-balance validation + every `getElementById`/`querySelector`
  target verified present in both `index.html` and `app/index.html`.
- Every local `href`/`src` reference verified to exist on disk.
- jsdom smoke test of the app: boot with no audio support, tab
  switching, settings overlay, mode chips, empty-state rendering —
  zero runtime errors.
- Served over HTTP and fetched every asset (site + app).
- APK verified with `android/verify_apk.py` (v2/v3 digests + RSA
  signatures + certificate match) and androguard (v1+v2+v3 present);
  SHA-256 on disk matches `app-info.json`.
