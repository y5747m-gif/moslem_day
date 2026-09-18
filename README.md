# VocalPure — Download site + standalone Android music player

VocalPure is an Android music player whose exclusive advantage is that it
**splits every song into two tracks**: 🎤 **Vocals** (lyrics) and 🎶
**Music** (instruments) — in real time, on device, offline.

The project has two completely separate parts:

1. **The website** (repo root) — a polished, fully static **download
   interface only**. It introduces the app, shows the real APK metadata
   (version, size, SHA-256, changelog), install guide, QR code, and a
   customizable animated background. **It contains no music player and no
   demo music** — everything playable lives in the app.
2. **The Android app** (`app/` → built into `downloads/*.apk`) — a
   **standalone music player** with its own UI, identity and feature set.
   It does **not** bundle the website: only the four `app/` files go into
   the APK.

## The app — features

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
- **Vocal / music splitter (4 modes)** — *Original / 🎤 Vocals only /
  🎶 Karaoke / 🎚 My mix* with independent stem faders, per-stem **mute**
  and **solo**.
- **5-band equalizer** — 60 Hz – 14 kHz with presets (Flat, Pop, Rock,
  Jazz, Bass Boost, Vocal Boost, …).
- **WAV export** — render vocals-only, karaoke or your custom mix to
  `.wav`. In the app the file is written straight to the phone
  (`…/Android/data/com.vocalpure.app/files/Music/VocalPure/`) via a native
  bridge — no download-page round trip.
- **Offline & private** — no network calls at all after launch; songs
  never leave the device.

## The website — features

- **Download center** — stable + beta APK cards, live metadata from
  `app-info.json`, SHA-256 display, copy-link button, install guide,
  requirements and changelog, QR code pointing at the APK URL.
- **Animated background** — drifting gradient orbs, grid glow and an
  interactive canvas particle field; **Background Studio** (bottom-right)
  to pick 6 theme presets or custom accents, tune particles, or upload a
  wallpaper — saved in `localStorage`.
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
│   ├── app.js              # player + adaptive vocal-isolation engine
│   └── app-info.json       # in-APK version/changelog fallback
├── android/                # APK build pipeline (no Android SDK needed)
│   ├── build_apk.py        # aapt2 → javac/dx → zip → v1+v2+v3 signing
│   ├── verify_apk.py       # independent re-implementation of AOSP verifiers
│   ├── bootstrap_tools.sh  # fetches/compiles the toolchain (see BUILDING.md)
│   ├── sync_assets.sh      # bundles app/ (only!) into assets/www
│   └── keystore/           # release signing key (intentionally committed)
└── downloads/
    ├── VocalPure-v2.7.0.apk        # signed stable app (Android 8.0+)
    └── VocalPure-v2.8.0-beta.1.apk # signed beta build
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
python3 android/build_apk.py --version-name 2.7.0 --version-code 270 \
    --out downloads/VocalPure-v2.7.0.apk
python3 android/verify_apk.py downloads/*.apk
```

One-time toolchain setup (`pip install jdk4py`, then
`./android/bootstrap_tools.sh`) is documented in `android/BUILDING.md`.

After a build, update `app-info.json` (`size`, `sha256`, `updated`,
`changelog`) — the website picks everything up automatically. The APK
bunds its own `app-info.json` (used by the app as a version fallback when
the native bridge is unavailable), while the in-app version labels come
from the native `AppBridge.appInfo()`.

## Vocal isolation — adaptive engine

Each imported song is analyzed offline with an on-device FFT (radix-2,
1024 samples, up to a 6-second window at a random offset) that measures:

- **centerRatio** — how much of the vocal band (170 Hz–4.3 kHz) energy
  sits in the center channel, and
- **bandFocus** — how much of the whole track's energy lives in that band.

The strongest strategy is then selected **per song**:

| Strategy | When | How |
|---|---|---|
| **Center extraction** | centerRatio ≥ 0.62 | Vocals = band-shaped mid (3 sub-bands, presence boost +2.5 dB @ 2.7 kHz); Music = side signal + low-passed mid so bass/kick survive. |
| **Center blend** | centerRatio ≥ 0.40 | Same chains, but vocals add a low-passed side return and music adds a center return with a vocal-band dip — smoother when the vocal isn't perfectly center-locked. |
| **Frequency focus** | mono or low center ratio | Vocals = band-pass 170 Hz–4.3 kHz with presence tilt; Music = band-reject of the same window with a high-shelf lift and a deeper mono notch. |

Every track therefore gets real, signal-adaptive isolation — nothing is
a no-op — and the engine reports its pick + estimated clarity in the
now-playing screen (“Strategy: center extraction · 81% of the vocal band
is center-locked · est. clarity 80%”). Stems are mixed live, then
compressed/limited with makeup gain and run through the 5-band EQ.
Export renders the exact same chain in an `OfflineAudioContext` to
16-bit PCM WAV.

> Note: this is spectral/channel-based isolation, not a deep-learning
> stem model — so results are best on mixed stereo recordings, as
> described. Use only on music you own or have the right to remix.

## Checks run on this repo

- `node --check` on all four JS bundles (site ×2, app ×2).
- HTML tag-balance validation + every `getElementById` target verified
  present in both the site and the app.
- Every local `href`/`src` reference verified to exist on disk.
- Headless DOM tests (jsdom, `/.apptest` harness): app — import, play,
  FFT analysis, all four modes, stem mixer, EQ, search, playlists,
  favorites, transport, settings, export, delete (42 checks); site —
  metadata filling, download links, no-player assertions (15 checks).
- APKs verified with `android/verify_apk.py` (v2/v3 digests + RSA
  signatures + certificate match) **and** androguard (v1+v2+v3 present,
  manifest fields, bundled-asset listing — no website content inside);
  SHA-256 on disk matches `app-info.json`.
