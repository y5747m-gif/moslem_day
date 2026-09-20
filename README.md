# VocalPure — Download site + standalone Android music player

VocalPure is an Android music player with an offline **spectral
voice-enhancement engine** that processes every song **before it plays**
(only very long files are processed live, in stream). It reduces
accompaniment, but is not a trained neural source-separation model and
cannot guarantee music-free vocals.

> **Unreleased source changes (2026-09-20):** (1) corrected Bluetooth
> broadcasts, system-managed media routing, transient focus recovery, safe
> disconnect pauses, playback buffering hint, and centre extraction in Max —
> see `tools/AUDIO_FIX_NOTES.md`; (2) **the music is now removed BEFORE
> playback** — every song is rendered through the AI engine offline first and
> only the purified render plays (files over 12 min still use the live
> engine), the WAV export became an instant write of that render, and a
> **pinned in-app control bar** (mini player) was added above the tab bar —
> see `tools/PREPROCESS_NOTES.md`. The existing v2.12.0 APK in `downloads/`
> has **not** been rebuilt with these changes.

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

- **Music removed BEFORE playback, not live** — every song is decoded once
  and rendered through the AI voice engine in an `OfflineAudioContext`
  (faster than real time, with a progress bar and a cancel-able auto-start),
  and the player then simply streams that purified render. The listener
  never hears a half-separated warm-up stream, the engine's stats over the
  *whole* track become the song's profile, and changing a separation
  setting re-renders the song (cached per setting, position preserved). See
  `tools/PREPROCESS_NOTES.md`. *(Source change — the released v2.12.0 APK
  still processes live.)*
- **Bounded memory by design** — pre-rendering is capped at 12 minutes
  (files whose metadata/decode says longer still play through the live
  streaming worklet, 100 % processed, never unfiltered), only the current
  render plus the two most recent stay cached, and the fail-closed graph
  keeps its no-unfiltered-path guarantee in both modes.
- **Pinned in-app control bar (mini player)** — a persistent bar docked
  above the tab bar on every screen while a song is selected: cover,
  title, render progress / artist, a thin progress line and
  play/pause/next/previous one tap away; the body opens the full player.
- **Instant WAV export** — the purified render already exists as a complete
  WAV, so saving is a straight chunked write to `Music/VocalPure` (native
  bridge) or a browser download — no 1× real-time recording. The
  capture-as-it-plays export is kept only for the live (over-12-min) files.
- **AI panel** — render progress while the song is prepared, then the
  whole-track analysis the offline render collected: voice activity, how
  many dB of music were cut, and the pitch the engine locked onto.
- **Max / Center voice** — combines spectral gating with centre extraction to
  reduce stereo accompaniment. Mono/centred instruments can still pass, and
  off-centre vocals or reverb can be lost. This is not “100% isolation”.
- **Cover art from the file itself** — embedded artwork is extracted
  straight from the audio bytes (ID3v2.2/.3/.4 APIC for MP3, FLAC PICTURE
  block, M4A/MP4 `covr` atom — moov at the front *or* the end — and OGG
  `METADATA_BLOCK_PICTURE`), downscaled to 512 px and shown in the library
  rows and the Now Playing screen; files without art get the built-in
  VocalPure artwork.
- **Pinned playback notification** — while a song plays, a persistent
  foreground notification (MediaSession + MediaStyle) shows the cover
  thumbnail, track title/artist, play/pause, next/previous and a one-tap
  **output switch**; it keeps working with the app in the background.
- **External audio handling** — Android manages the media route; the app does
  not force call mode or a speaker fallback. Correct A2DP/headset broadcasts
  pause on disconnect without autoplay on reconnect. Transient audio-focus
  interruptions resume only when playback was active and not manually paused.
  A playback latency hint gives the browser room for buffering. Physical-device
  testing is still required; these changes do not guarantee stutter-free audio.
- **Long recordings still stream through the live engine** — files over
  12 minutes are piped into the worklet through the media element (`blob:`
  for imported files, the Android streaming bridge with real HTTP **range**
  support for phone-library files) instead of a whole-file decode, so a
  two-hour lecture cannot exhaust the phone's memory — still 100 %
  processed, never unfiltered. The ancient `decodeAudioData` + Base64
  *playback* path that used to crash the app stays gone.
- **Library** — import multiple songs at once (file picker, drag & drop),
  auto-parsed “Artist – Title” names, **embedded cover art** extracted from
  the file (or the built-in artwork when none), duration, sort by
  title/artist/date, remove. Library (audio included) stored in IndexedDB,
  restored on launch, fully offline.
- **Now-playing screen** — the song's **embedded cover art** (or the
  built-in artwork), live frequency visualizer, seek bar, prev / play /
  next, shuffle, repeat (off / all / one), playback speed 0.5×–2×, volume
  + mute, sleep timer (15/30/60 min).
- **Search** — instant title/artist filter with match count.
- **Playlists & favorites** — create/rename/delete playlists, star
  favorites; all persisted on-device. **Queue** — live “Up next” list.
- **Separation controls (voice only)** — four strength presets
  (Soft / Balanced / Strong / Max), a voice-boost make-up gain and a
  “silence the music-only parts” gate. None of them can bring the music back.
- **5-band equalizer** — 60 Hz – 14 kHz with presets (Flat, Pop, Rock,
  Jazz, Bass Boost, Vocal Boost, …).
- **WAV export (live-engine files)** — for over-12-minute tracks the
  purified voice is captured from the live engine as the song plays and
  streamed to disk in 1.5 MB chunks (native
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
│   ├── app.js              # player: pre-playback render pipeline, transport,
│                           # library, AI panel, pinned mini player
│   ├── vp-ai-engine.js     # the AI voice engine (AudioWorklet, engine v6)
│   ├── vp-cover.js         # embedded cover-art extractor (ID3v2/FLAC/MP4/OGG)
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
│   ├── test_cover.js       # cover-art extractor: synthetic ID3v2/FLAC/MP4/OGG
│   ├── smoke_app.js        # jsdom functional test + undeclared-symbol scan
│   └── smoke_site.js       # jsdom test of the download page + metadata
└── downloads/
    ├── VocalPure-v2.12.0.apk        # signed stable app (Android 8.0+) — AI voice engine,
    │                                #   cover art, pinned notification, stable output routing
    ├── VocalPure-v2.11.0.apk        # previous stable (kept for reference)
    ├── VocalPure-v2.9.0.apk         # older stable (kept for reference)
    └── VocalPure-v2.7.0.apk         # legacy stable (kept for reference)
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
python3 android/build_apk.py --version-name 2.12.0 --version-code 2120 \
    --out downloads/VocalPure-v2.12.0.apk
python3 android/verify_apk.py downloads/VocalPure-v2.12.0.apk
```

One-time toolchain setup (`pip install jdk4py`, then
`./android/bootstrap_tools.sh`) is documented in `android/BUILDING.md`.

After a build, update `app-info.json` (`size`, `sha256`, `updated`,
`changelog`) — the website picks everything up automatically. The APK
bunds its own `app-info.json` (used by the app as a version fallback when
the native bridge is unavailable), while the in-app version labels come
from the native `AppBridge.appInfo()`.

## The AI voice engine (engine v6)

Playback has exactly one destination — the isolated voice. Normal songs are
purified BEFORE they ever play; only over-long files are processed live:

```
normal songs:  file → decode → offline render through the AI worklet
             → purified WAV → <audio> → voice boost → compressor
             → 5-band EQ → master → speakers
long files:    <audio> (stream) → MediaElementSource → AI worklet
             → voice boost → compressor → 5-band EQ → master → speakers
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

The cues are combined in a logit, squashed by a per-preset steepness, gated
and smoothed (3-tap + AR). Soft/Balanced/Strong apply a residual floor
(0.10/0.055/0.030) and time smoothing; **Max** disables both and runs the
*pure* path — a hard 115 Hz–9 kHz vocal band, a 0.35 logit gate and a zero
floor — so classified music goes to full silence. The mask is applied to
both channels, the frame is re-packed, inverse-transformed and
overlap-added; added latency is one FFT frame (≈21 ms at 48 kHz).

Live metrics (voice ratio, music-cut dB, F0, clarity, latency) are posted to
the app ~4×/second — that is what the AI panel displays, and the app turns
the metrics into a per-song profile after ~4 s of playback (stored in
IndexedDB, shown as “✓ AI” in the list).

**Fail-closed**: WebViews without `AudioWorklet` get *no* playback path —
the media source is connected only to the AI node, so a missing engine
keeps the song silent and the UI says exactly why, with a one-tap retry in
Settings (“Re-learn song”). There is deliberately no filter-chain fallback:
playing the music nearly unfiltered while claiming it was removed is worse
than saying plainly that the engine could not start.

> Note: this is an adaptive spectral-masking separator with online learning,
> not a deep-learning stem model (no weights are downloaded; the APK stays
> ~0.1 MB). Use it only on music you own or have the right to remix.

## Checks run on this repo

```bash
node tools/verify_app.js      # static: syntax, DOM contract, assets, metadata
node tools/test_ai_engine.js  # runs the real worklet source in Node (16 checks)
node tools/test_cover.js      # cover-art extractor on synthetic ID3v2/FLAC/MP4/OGG files
node tools/smoke_app.js       # jsdom functional test + undeclared-symbol scan
node tools/smoke_site.js      # jsdom test of the download page
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
- **`test_cover.js`** — builds tiny synthetic audio files that carry real
  embedded artwork (ID3v2.2/.3/.4 APIC in all four text encodings, FLAC
  PICTURE, M4A `covr` with the moov atom at the front *and* at the end, OGG
  `METADATA_BLOCK_PICTURE`) and asserts the production extractor
  (`app/vp-cover.js`) returns the exact same image bytes — plus
  corrupt-tag, truncated-input and base64 round-trip checks.
- **`smoke_app.js`** — boots the real app inside jsdom with mocked Web Audio
  (incl. an `OfflineAudioContext` render mock), IndexedDB and the Android
  bridge, then drives it: device scan, **pre-playback processing** (regular
  songs play the purified render blob; the over-length fixture plays live),
  worklet creation + params, live meters, strength/boost/denoise controls
  (with re-rendering), transport, the **pinned in-app control bar**, the
  pinned-notification bridge (meta/play-state/focus/wake-lock), audio output
  routing (settings change, Bluetooth disconnect fallback, native output
  cycling), embedded-cover extraction from a real ID3v2 MP3 into the rows,
  Now Playing and the notification, search, playlists, EQ, themes, import,
  oversized-file rejection, **instant pre-render export**, fail-closed boot
  without AudioWorklet, and library clearing — plus a scope analysis that
  fails on any symbol used but never declared.
- **`smoke_site.js`** — the download page fills in live metadata from
  `app-info.json` (version, size, SHA-256, date, changelog), both download
  buttons point at the APK that is actually in `downloads/`, the QR code is
  produced, no runtime error fires, and the copy promises none of the removed
  features (karaoke / two-track / “my mix”).
- APKs verified with `android/verify_apk.py` (v2/v3 digests + RSA signatures
  + certificate match) **and** androguard (v1+v2+v3 present, manifest fields,
  bundled-asset listing — no website content inside); the file on disk
  matches `app-info.json`.
