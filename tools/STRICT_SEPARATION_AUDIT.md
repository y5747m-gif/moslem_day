# Strict Voice Only — v2.11.0 rework notes

Date: 2026-09-20. Branch: `arena/01a0be34-moslem-day` (from v2.10.0 `bce4295`).

This file supersedes the v2.10.0 "release blocked" audit. The app was reworked so
that voice isolation is fail-closed: when the engine cannot run, the app stays
silent and says why, instead of playing the music nearly unfiltered. The strict
regression probe now passes with zero release-blocking regressions. This is still
an on-device **spectral** engine — no neural model was integrated, and no
real-recording listening test was performed. Read the caveats before shipping.

## What changed since v2.10.0

**Fail-closed audio graph (`app/app.js`)**

- `ensureAudioEl()` leaves the media source UNCONNECTED. There is no longer any
  `mediaSrc.connect(voiceGain)` direct path anywhere in the app.
- `startEngine()` is the single place that wires the source, and only as
  `source → AI worklet → voice chain`. A 6 s watchdog converts a hung module
  load into a visible error.
- The `useFilterEngine()` fallback is deleted. The `engineKind` state is now
  `ai | starting | error | none`; `engineError(reason)` shows the exact cause in
  the engine line, the Now Playing chip, the settings status and a toast.
- `startAt()` refuses to play when there is no media source (which would bypass
  the engine). The "Re-learn song" button doubles as the engine retry.
- The default strength is now **strong** in the settings default, the settings
  select, and the Now Playing buttons.

**Sustained-instrument suppressor (`app/vp-ai-engine.js`)**

- New multi-second voice-activity gate: when no dip (syllable gap / consonant),
  spectral-flux onset, or pitch jump has been seen for ~1.5 s, a slow gate
  closes toward a per-preset floor (full mute at Max, −18 dB at strong). Any new
  voice-like change reopens it within milliseconds.
- The `d.bypass` unity-mask parameter is removed; unknown params are ignored.
- Residual floors lowered (max: 0.001 ≈ −60 dB) and the sustained-gate attack
  rate made per-preset (max closes in ~0.25 s, strong in ~0.6 s).

**Appearance (`app/app.js` / `app/index.html` / `app/style.css`)**

- Theme selection now repaints `--glow-1/--glow-2/--glow-line` background washes
  across the shell, top bar, hero, Now Playing and cards (previously only
  buttons/accents changed, so "change background" looked broken).
- Wallpaper mode makes cards translucent (60% default visibility); other modes
  stay solid. Theme/background changes show confirmation toasts.

## Reproduce

```sh
npm --prefix tools install --no-package-lock --ignore-scripts
npm --prefix tools test                 # legacy suite (verify + DSP + app smoke + site smoke)
npm --prefix tools run test:strict      # strict probe: 0 release-blocking regressions
npm --prefix tools run test:release     # legacy + strict regression gate
```

## Measured results

All suites pass: repository **32**, DSP **16**, app smoke **58**, website smoke
**12** (118 checks), strict **7/7** (3 guards + 4 leakage probes).

Legacy DSP fixture (centered voice + side music, strong): backdoor probe
(bypass:true still separates) **−34 dB**, music-only **−34 dB**, voice **−2.8 dB**,
bass **−22.1 dB**, hats **−12.4 dB**, voice/music ratio +7.2 dB, mono intro
**−34 dB**, mono voice −14.4 dB, 9.1× realtime.

Strict probe (deterministic CC0 additive-synth drone with harmonic energy inside
the vocal band, no singing present, max + gate on, 2 s excluded, 6 aligned
seconds measured at the legacy 1023-sample latency):

| Sample rate | Input | Output/input energy | Required |
| --- | --- | ---: | ---: |
| 44,100 Hz | one channel | −60.00 dB | ≤ −50 dB |
| 44,100 Hz | stereo, centred | −60.00 dB | ≤ −50 dB |
| 48,000 Hz | one channel | −60.00 dB | ≤ −50 dB |
| 48,000 Hz | stereo, centred | −60.00 dB | ≤ −50 dB |

−60.00 dB is the measurement floor of the max preset (residual gain 0.001):
the window from 2–8 s is fully muted. Sub-window analysis shows the gate
engages ~1.5 s after the last voice-like change; steady-state leakage from 3 s
on is −60 dB at both sample rates. A sustained sung-like tone with natural
vibrato passes through at −0.5…−2 dB over 4 s (vibrato flux keeps the gate
open); only unnaturally static straight tones are ducked.

Source guards (previously failing, now passing):

1. No `mediaSrc.connect(voiceGain)` direct path in `app/app.js`.
2. No `useFilterEngine` fallback in `app/app.js`.
3. No `.bypass` unity-mask parameter in `app/vp-ai-engine.js`.

These guards detect known paths, not all possible paths.

## Honest caveats (still true)

- No `.onnx` / `.tflite` / `.pt` model is integrated; separation is spectral
  (learned-mask + frame gate + sustained-activity gate), not neural source
  separation. Do not describe it as a neural engine.
- The strict probe uses a synthetic drone, not real multitracks. Real-song
  leakage, vocal preservation/intelligibility and listening review are still
  unmeasured. Do not assert 50–60 dB on unseen songs from this probe.
- "Voice survives −2.8 dB" compares processed mixture power against processed
  voice-only power; it cannot establish intelligibility.
- Silent output alone must not pass unnoticed: the smoke suite now asserts that
  the no-AudioWorklet case shows a visible failure (chip, settings, toast) and a
  retry path, rather than silently playing nothing.
- No long-file RSS measurement, no `adb`/device install, no listening test.

## Release checklist for v2.11.0

1. Synchronize app assets, build/version (2.11.0 / 2110)/sign the APK, check
   manifest/package/assets bytes and v1/v2/v3 signatures.
2. Install on real devices (old WebView without AudioWorklet + modern), verify
   the fail-closed UX and the retry path.
3. Update true size/hash/site/changelog and open a release PR.
