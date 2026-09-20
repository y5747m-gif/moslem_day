# Pre-playback processing + pinned control bar — unreleased, 2026-09-20

Source changes vs the released v2.12.0 APK (the APK in `downloads/` has **not**
been rebuilt with these changes). This note follows the same convention as
`tools/AUDIO_FIX_NOTES.md`.

## What changed, and why

Two product requests:

1. **The music must be removed BEFORE playback, not live.** In ≤ v2.12.0 the
   engine processed a live streamed feed in an AudioWorklet, so the song
   started playing while the engine was still warming up its voice/music
   model.
2. **A pinned, always-visible way to control the music inside the app.**

## Pre-playback processing (app/app.js)

- Every song is now rendered through the **same** AI voice engine
  (`vp-ai-voice`, `app/vp-ai-engine.js` — unchanged) inside an
  `OfflineAudioContext` at 48 kHz **before** the song plays:
  bytes → one whole-file decode → offline worklet render → 16-bit stereo WAV
  → the `<audio>` element streams that purified render. Progress is reported
  once per rendered second via `OfflineAudioContext.suspend()` checkpoints
  (which also let the worklet's stats reach the page and become the song's
  full-track AI profile).
- **Bounded memory, by design:** pre-rendering is skipped for files longer
  than `PP_MAX_SECONDS` (12 min, ~460 MB peak for decode+render). Longer
  recordings still play through the **live** streaming worklet exactly as
  before — still 100 % processed, never unfiltered. A duration pre-guard
  (from the import/scan metadata) avoids even decoding such files; a
  post-decode re-check is the backstop.
- **Routing invariant (`wireGraph` is the only `connect` site):** the media
  element's source is never wired straight to the output *for the original
  file*. In pre mode the element only ever sees the already-purified WAV, so
  its direct `mediaSrc → voiceGain` routing cannot leak unfiltered music; in
  live mode the only routing is through the AI node. The fail-closed,
  no-fallback contract is kept (guards updated in `tools/verify_app.js` and
  `tools/test_strict_acceptance.js`).
- Rendered results are cached per (song, strength, gate) key — the current
  render plus the two most recent ones — so changing separation settings
  re-renders (position and play state preserved), and skipping around the
  queue is instant. The next queued song is pre-rendered silently in the
  background.
- **WAV export is instant** for pre-processed songs: the purified render is
  already a complete WAV, so it is written to `Music/VocalPure` in 1.5 MB
  chunks (native bridge) or offered as a download (browser) with no
  real-time re-recording. The old capture-as-it-plays export is kept only
  for the live (too-long) files.
- The native pinned playback notification (MediaSession service) is
  untouched and keeps tracking track changes, play/pause, seek and output.

## Pinned in-app control bar (mini player)

A bar is docked above the tab bar on every screen while a song is selected:
cover art, title, artist (or live render progress), a thin progress line,
play/pause and next/previous; tapping the body opens the full player.
During pre-processing it shows render progress; pressing play while a render
is in flight toggles whether the song auto-starts.

## Validation

- `node tools/verify_app.js` — 34/34 (incl. updated static guards).
- `node tools/smoke_app.js` — 97/97: playback modes (pre for normal songs /
  live for the over-length fixture), transport, the pinned bar, instant
  export, fail-closed boot without AudioWorklet, etc. Harness changes:
  an `OfflineAudioContext` mock, full-file fetch on the audio-bridge URL, a
  long-track duration fixture, and a `structuredClone` passthrough for Blobs
  (fake-indexeddb otherwise flattens jsdom Files into plain objects, which
  no real browser does).
- Real-device behaviour still requires validation on hardware: offline
  render speed on low-end CPUs, peak memory on 10–12 min files, WebView
  `OfflineAudioContext` + worklet reliability, and background pre-fetching.

## Honest limits

- Render speed depends on the device; expect roughly real-time-ish to
  several-times-faster renders. The UI blocks playback behind the render
  (with progress + a cancel-able auto-start) rather than ever playing the
  half-processed stream.
- Songs still decode once in full (bounded by the 12-minute cap): this
  trades the v6 "never decode" property for processed-before-playback
  quality, with the live engine kept precisely for the files that cannot
  afford the peak.
