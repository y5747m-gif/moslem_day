# VocalPure — APK Download Website + Lark-style Music Player

A polished, fully static website for downloading the **VocalPure** Android
app — a complete music player (like Lark Player) whose exclusive advantage
is that it **splits every song into two tracks**: 🎤 **Vocals** (lyrics)
and 🎶 **Music** (instruments).

No build step, no dependencies, no backend for the site itself. Just open
it in a browser or serve the folder with any static file server.

## The player (works right here in the browser)

The `#demo` section is a full music player, not a mockup:

- **Library like Lark Player** — add multiple songs (drag & drop or file
  picker), search, sort (recent / title / artist / duration), auto-parsed
  “Artist – Title” names. The library (audio included) is stored in
  IndexedDB and restored on reload, fully offline.
- **Playlists & favorites** — create playlists, tap ＋ on any song to add
  it, star favorites; all persisted on-device.
- **Transport** — previous / play / next, shuffle, repeat (off / all /
  one), seek bar, volume + mute, playback speed (0.5×–2×), sleep timer,
  “Up next” queue, and a sticky mini-player while you browse the page.
- **Two-track splitter** — every song is separated live into a vocal stem
  and a music stem with independent level faders, per-stem **mute** and
  **solo**, and one-tap presets: *Original / 🎤 Vocals only / 🎶 Karaoke /
  🎚 My mix*. Remove the instruments and keep only the lyrics — or remove
  the voice and sing karaoke.
- **5-band equalizer** — 60 Hz – 14 kHz with presets (Pop, Rock, Jazz,
  Bass Boost, Vocal Boost, …), applied to everything you hear.
- **WAV export** — render vocals-only, karaoke, or your custom mix to a
  downloadable `.wav` file (offline render, nothing uploaded).

## Site features

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
- **Download center** — stable + beta APK cards, live file size/version from
  `app-info.json`, SHA-256 display, copy-link button, install guide, QR code,
  requirements and changelog.
- **Mobile-friendly** — responsive layout, hamburger menu, touch-ready controls.
- **Accessible** — semantic HTML, ARIA labels, keyboard-operable transport,
  `prefers-reduced-motion` support.

## Project structure

```
├── index.html              # entire site (player + customizer + footer)
├── css/style.css           # theme, layout, player UI, animations, responsive
├── js/
│   ├── background.js       # particle engine + Background Studio + persistence
│   └── app.js              # nav, reveal, downloads, full music-player engine
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
    ├── VocalPure-v2.6.0.apk        # signed, installable app (Android 8.0+)
    └── VocalPure-v2.7.0-beta.1.apk # signed beta build
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
a WebView host that bundles the entire website (full player, splitter,
equalizer, Background Studio) and runs it 100% offline. Installation
requires Android 8.0+; enable "install from unknown sources" when prompted.
The file picker supports selecting **multiple songs at once**.

Rebuild after changing the site:

```bash
export VP_TOOLS=$HOME/.vp-tools VP_JAVA=$(python3 -c 'import jdk4py; print(jdk4py.JAVA)')
./android/sync_assets.sh
python3 android/build_apk.py --version-name 2.6.0 --version-code 260 \
    --out downloads/VocalPure-v2.6.0.apk
python3 android/verify_apk.py downloads/*.apk
```

Then update `app-info.json` (`size`, `sha256`, `updated`, `changelog`) —
the website picks everything up automatically. (The APK signature embeds a
timestamp, so the `app-info.json` *inside* the APK is always one build
behind the repo copy — this is expected and harmless: in-app version labels
come from the native bridge, and the download center is hidden in-app.)

One-time toolchain setup (`pip install jdk4py`, then
`./android/bootstrap_tools.sh`) is documented in `android/BUILDING.md`.

## Vocal isolation — how it works

The same engine powers the site player and the installed app:

* **Stereo songs** — center-channel extraction: vocals are mixed to the
  center, so the vocal stem keeps the mid signal (band-shaped, 85 Hz–
  11.5 kHz) while the music stem keeps the side signal plus a low-passed
  copy of the mid so the bass/kick survives in karaoke mode.
* **Mono songs** — there is no side signal at all, so a frequency-focus
  fallback isolates the vocal band (170 Hz–4.3 kHz) for the vocal stem and
  removes it for the music stem. Every track gets *some* isolation —
  nothing is a no-op.
* Both stems are mixed live (your fader positions), run through a
  compressor/limiter with makeup gain, then through the 5-band EQ — loud,
  balanced, and never clipping.

## Checks run on this repo

- `node --check` on both JS bundles (syntax).
- HTML tag-balance validation + every `getElementById` target verified present.
- Every local `href`/`src` reference verified to exist on disk.
- Headless DOM tests (jsdom): library tabs, playlists, transport, all four
  split modes on stereo + mono graphs, stem mixer, EQ, sleep timer, WAV
  export — zero runtime errors.
- Served over HTTP and fetched every asset (`index.html`, CSS, JS, JSON, APKs).
- APKs verified with `android/verify_apk.py` (v2/v3 digests + RSA signatures
  + certificate match) and androguard (v1+v2+v3 present); SHA-256 on disk
  verified to match `app-info.json`.
