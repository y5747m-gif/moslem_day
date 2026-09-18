# VocalPure — APK Download Website

A polished, fully static website for downloading the **VocalPure** Android app —
an AI music player that analyzes songs, removes instrumental tracks, and keeps
only the vocals.

No build step, no dependencies, no backend. Just open it in a browser or serve
the folder with any static file server.

## Features

- **Eye-catching design** — deep black-blue canvas with harmonious purple/blue
  gradients, glassmorphism cards, and animated phone mockups.
- **Moving background** — drifting gradient orbs, grid glow, and an interactive
  canvas particle field with constellation links.
- **Background Studio** (paint-palette button, bottom-right) — visitors can:
  - pick from 6 theme presets or set their own accent colors,
  - toggle animation and particle connections,
  - adjust particle count, speed, glow and color shift,
  - upload their **own wallpaper image** (opacity + blur controls),
  - everything auto-saves in `localStorage`.
- **Live vocal-isolation demo** — runs 100% in the browser with Web Audio:
  upload any song (or generate the built-in stereo demo mix) and switch between
  *Original / Vocals only / Karaoke*, with a real-time visualizer, seek and volume.
- **Download center** — stable + beta APK cards, live file size/version from
  `app-info.json`, SHA-256 display, copy-link button, install guide, QR code,
  requirements and changelog.
- **Mobile-friendly** — responsive layout, hamburger menu, touch-ready controls.
- **Accessible** — semantic HTML, ARIA labels, keyboard-operable demo transport,
  `prefers-reduced-motion` support.

## Project structure

```
├── index.html              # entire site (sections + customizer + footer)
├── css/style.css           # theme, layout, animations, responsive
├── js/
│   ├── background.js       # particle engine + Background Studio + persistence
│   └── app.js              # nav, reveal, downloads, Web Audio live demo
├── app-info.json           # release metadata (single source of truth for
│                           # version, sizes, checksums, changelog)
├── android/                # APK build pipeline (no Android SDK needed)
│   ├── build_apk.py        # aapt2 → javac/dx → zip → v1+v2+v3 signing
│   ├── verify_apk.py       # independent re-implementation of AOSP verifiers
│   ├── bootstrap_tools.sh  # fetches/compiles the toolchain (see BUILDING.md)
│   ├── sync_assets.sh      # bundles the website into the app (assets/www)
│   └── keystore/           # release signing key (intentionally committed —
│                           #  see keystore/README.md)
└── downloads/
    ├── VocalPure-v2.4.1.apk        # signed, installable app (Android 8.0+)
    └── VocalPure-v2.5.0-beta.2.apk # signed beta build
```

## Run locally

```bash
cd moslem_day
python3 -m http.server 8080
# open http://localhost:8080
```

(Any static server works: `npx serve`, Nginx, GitHub Pages, Netlify, …)

## The Android app

`downloads/*.apk` are **real signed APKs** built by `android/build_apk.py` —
a WebView host that bundles the entire website (player, isolation engine,
Background Studio) and runs it 100% offline. Installation requires
Android 8.0+; enable "install from unknown sources" when prompted.

Rebuild after changing the site:

```bash
./android/sync_assets.sh
python3 android/build_apk.py --version-name 2.4.1 --version-code 241 \
    --out downloads/VocalPure-v2.4.1.apk
python3 android/verify_apk.py downloads/*.apk
```

Then update `app-info.json` (`size`, `sha256`, `updated`, `changelog`) —
the website picks everything up automatically.

## Vocal isolation — how it works

The same engine powers the site demo and the installed app:

* **Stereo songs** — center-channel extraction: vocals are mixed to the
  center, so the side signal carries the instruments. "Vocals only" keeps
  the mid (band-shaped, 85 Hz–11.5 kHz), karaoke keeps the side and returns
  a low-passed copy of the mid so the bass/kick survives.
* **Mono songs** — there is no side signal at all, so a frequency-focus
  fallback isolates the vocal band (170 Hz–4.3 kHz) instead. Every track
  gets *some* isolation — nothing is a no-op.
* All isolated paths run through a compressor/limiter with makeup gain, so
  results are loud but never clip.

## Checks run on this repo

- `node --check` on both JS bundles (syntax).
- HTML tag-balance validation + every `getElementById` target verified present.
- Every local `href`/`src` reference verified to exist on disk.
- Served over HTTP and fetched every asset (`index.html`, CSS, JS, JSON, APKs).
- APK SHA-256 on disk verified to match `app-info.json`.
