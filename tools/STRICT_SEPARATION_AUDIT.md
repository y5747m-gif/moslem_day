# Strict Voice Only — release blocked

Date: 2026-09-20. Baseline: `983c671e207f78b680d2dcab849f9828d790875d` (v2.10.0).

**This change is a diagnostic regression test, not the requested engine replacement. Do not ship it as v2.11.0 or describe it as real source separation.** App code, APKs, release metadata and website remain unchanged deliberately. No model has been selected, integrated or evaluated. No real-recording listening test has been performed.

## Reproduce

```sh
npm --prefix tools install --no-package-lock --ignore-scripts
npm --prefix tools test                 # legacy suite
npm --prefix tools run test:strict      # expected exit 1 on v2.10.0
npm --prefix tools run test:release     # legacy + necessary strict regression gate
```

`test:release` is only a necessary regression gate, NOT release certification. It still needs real-model, native-runtime and reference-recording tests below. The legacy command is preserved so that existing behavior can be compared without disguising it as strict compliance.

## Measured results

The existing suites passed: repository **27**, DSP **16**, app smoke **54**, website smoke **12** (109 checks). Their acceptance criteria are insufficient:

- Legacy music-only fixture: output/input energy **−30.5 dB**, accepted by its −20 dB threshold.
- Bass **−21.1 dB**, hats **−13.0 dB**. These are band measurements, not total accompaniment leakage.
- Reported “voice survives” **−2.9 dB** compares processed mixture power against processed voice-only power, so it cannot establish intelligibility or uncontaminated vocal retention.
- The smoke suite explicitly expects playback with the old filter when AudioWorklet is missing.

New regression: a deterministic, original CC0 additive-synth instrumental signal with harmonic energy inside the vocal band. No singing is present. The actual shipping worklet processes the signal using **max** and gate enabled. Two seconds are excluded for initialization; six aligned seconds are measured using the legacy 1023-sample latency. The harness allocates only fixed-size audio blocks (this is not an Android RSS measurement).

| Sample rate | Input | Output/input energy | Required |
| --- | --- | ---: | ---: |
| 44,100 Hz | one channel | −0.57 dB | ≤ −50 dB |
| 44,100 Hz | stereo, centred | −0.57 dB | ≤ −50 dB |
| 48,000 Hz | one channel | −1.20 dB | ≤ −50 dB |
| 48,000 Hz | stereo, centred | −1.20 dB | ≤ −50 dB |

All four fail. The target is ≤ −60 dB for music-only sections. Since this fixture contains no vocal, output energy is unwanted instrumental leakage. These results are not mixed-stem SDR, not a real-song result and not evidence about a future neural model. Identical stereo channels are intentional: rejecting only side-panned instruments is insufficient.

Three additional narrow source guards fail:

1. `ensureAudioEl()` connects `mediaSrc` directly to `voiceGain` before model readiness.
2. `startEngine()` calls `useFilterEngine()` on worklet failure/unavailability.
3. The worklet accepts `d.bypass`, setting the spectral mask to unity.

These guards detect known paths, not all possible paths. They do not substitute for instrumented audio-graph and failure-injection tests.

## Existing APK only (not a new build)

- File: `downloads/VocalPure-v2.10.0.apk`
- Bytes: **111085**
- SHA-256: `2589c3f4855597772d8bba7a2c7a61c9cd5803fac807b212386c83e548124587`
- `python3 android/verify_apk.py downloads/VocalPure-v2.10.0.apk`: v2/v3 content digests and RSA signatures pass, certificate matches, v3 SDK range starts at 26.
- That command does not independently verify v1 or actually install the APK. No new manifest/version or device-install verification is claimed.
- No `.onnx`, `.tflite`, `.pt` or `.pth` model in the APK or checkout. No real audio fixture in the checkout. Neither `adb` nor `java` was on PATH in this session.

## Remaining implementation and acceptance work

A candidate architecture is a **native Android CPU ONNX separator**, with an explicitly licensed/pinned MDX-family model and optional NNAPI only where supported by its operators. This is a proposal, not a validated model choice; neither compatibility, speed nor quality is established. The existing custom Java/dx APK pipeline has no ONNX runtime integration. Adding a model filename or inventing an adapter would not make it executable.

Before changing release metadata:

1. Acquire and record exact model source, redistribution license, hash, tensor contract, normalization, STFT parameters, target sample rate and operator requirements. Verify actual inference on API 26, supported ABIs and representative memory budgets. Package weights and runtime together (or implement explicit, integrity-checked authorized provisioning).
2. Decode with MediaExtractor/MediaCodec in bounded windows; use stateful resampling and normalized overlap-add with correct padding, end-of-stream and cancellation behavior. Bound queued work, disk-cache growth and resident memory. Restore original rate where practical. NNAPI needs measured compatibility; CPU is mandatory.
3. Play only the resulting vocal PCM/cache. Remove direct edges, filter fallback and bypass parameter. Keep output disconnected until validated inference results exist. Fail closed on missing/corrupt/incompatible weights, inference error, NaN, timeout, exhausted storage and process cancellation; show a diagnostic reason.
4. Derive a conservative residual suppressor from actual predicted sources/mask, with no positive gain floor. Estimates are not automatically calibrated probabilities. Discard accompaniment after suppression; never expose a remixer. Default and only playable mode: Strict Voice Only, with explicit vocal-dropout warning.
5. Feed playback and lossless WAV export from the same final vocal stream; test seek/reset/track-switch and ensure no stale or uncertain chunk is audible or exported. Replace misleading quality and “music removed” claims.
6. Supply licensed real multitracks and a representative real song, retain references, test mono/stereo at 44.1/48 kHz, report total and windowed instrumental leakage plus vocal preservation/intelligibility. Silent output alone must not pass. Nonlinear mixture attribution must not be estimated merely by subtracting independently processed sources. Perform listening review, including pure-instrument sections. Do not assert 50–60 dB on unseen songs from this probe.
7. Run a long native-file test recording peak/RSS trend, playback/export integration tests and fault injection. Add successful neural-backend tests to the release gate once implemented, without replacing inference with reference stems or a mock.
8. Only after acceptance, synchronize app assets, build/version/sign APK, check manifest/package/assets/model bytes and v1/v2/v3 signatures, install on devices, update true size/hash/site/changelog, and open a release PR.

No release was built because these conditions remain unmet. Zero leakage cannot generally be guaranteed from arbitrary overlapping sources while preserving all vocals. The practical target still requires measured and audible validation, not a renamed spectral mask.
