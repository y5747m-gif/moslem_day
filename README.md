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
└── downloads/
    ├── VocalPure-v2.4.1.apk        # ⚠ DEMO PLACEHOLDER (see below)
    └── VocalPure-v2.5.0-beta.2.apk # ⚠ DEMO PLACEHOLDER (see below)
```

## Run locally

```bash
cd moslem_day
python3 -m http.server 8080
# open http://localhost:8080
```

(Any static server works: `npx serve`, Nginx, GitHub Pages, Netlify, …)

## ⚠ Replacing the placeholder APKs before launch

The `.apk` files in `downloads/` are tiny demo placeholders (zips containing a
readme) so every download flow can be tested end-to-end. Before publishing:

1. Build your signed release APK in Android Studio
   (*Build › Generate Signed Bundle / APK*).
2. Overwrite the placeholder, e.g. `downloads/VocalPure-v2.4.1.apk`.
3. Update `app-info.json`: `version`, `size`, `sha256`, `updated`, `changelog`.
4. Get the checksum with `sha256sum downloads/*.apk`.

The website reads `app-info.json` at load and updates all version labels,
sizes, checksums and links automatically.

## Checks run on this repo

- `node --check` on both JS bundles (syntax).
- HTML tag-balance validation + every `getElementById` target verified present.
- Every local `href`/`src` reference verified to exist on disk.
- Served over HTTP and fetched every asset (`index.html`, CSS, JS, JSON, APKs).
- APK SHA-256 on disk verified to match `app-info.json`.
