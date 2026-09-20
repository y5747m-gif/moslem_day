# Audio fixes — unreleased, 2026-09-20

## Findings and changes

- The native receiver used a nonexistent A2DP action and wrong state extra.
  It now uses Android's A2DP profile connection broadcast and profile state.
- The reflection-based profile listener treated its first argument (profile ID)
  as the proxy, called a nonexistent zero-argument connection method and tried
  to close a nonexistent BluetoothProxyProxy type. Output enumeration now uses
  the public AudioDeviceInfo API, without a profile proxy or Bluetooth permission.
- WebView/WebAudio owns the media sink: speakerphone/call-mode flags cannot
  reliably route it. Removed those writes and unsupported speaker/earpiece
  choices. Android's media-output panel selects the actual sink. Auto/Bluetooth/
  wired are preferences/availability checks, not guaranteed forced routes.
- Disconnect pauses instead of forcing sound onto the loudspeaker; reconnect
  never starts audio automatically. Initial sticky headset broadcasts are ignored.
- JS previously ignored focus gain/duck. Transient loss and duck now pause and
  resume on gain only if playback was active. Manual pause, permanent loss and
  disconnect cancel pending resume. A denied native focus request pauses playback.
- AudioContext requests `latencyHint: "playback"` instead of the default interactive
  buffer. Browsers can ignore this hint; it is not proof that underruns are fixed.
- The old mask applied the same gain to both stereo channels, retaining side
  instruments in bins opened by a voice. Max now extracts the masked centre.
  Softer presets retain their existing stereo behavior. Removed the app's
  misleading “100% Isolation” preset label.

## Separation limitations — still unresolved

This is spectral DSP, not a pretrained vocal-separation network. Centre
extraction removes stereo difference energy, not all instruments. Centred/mono
instruments and vocal-overlapping frequencies can remain. Off-centre vocals,
stereo reverb and sustained singing may be reduced. Fixing the general complaint
requires integrating and benchmarking a real source-separation model with a
suitable licence and mobile compute/memory budget, plus listening tests on real
mixed recordings. No model has been added and no complete-isolation claim is made.

## Validation

`npm --prefix tools run test:release` passes (repository checks, DSP, cover art,
app smoke, site smoke and strict synthetic leakage probes). Native source
contracts additionally run as part of `npm test`; these are not Java compilation
or Android instrumentation tests.

Added browser regressions cover temporary focus loss, duck/gain, manual-pause
cancellation, permanent loss, disconnect without speaker fallback and reconnect
without autoplay. DSP probes at 44.1/48 kHz measure residual stereo difference
below -100 dB with Max and synthetic centred vocal retention of -4.6/-5.2 dB.
Those numbers are NOT real-recording music suppression measurements.

## Release / device checklist

The existing v2.12.0 APK and its metadata are unchanged. This environment lacks
Android build tools/JDK; the Java host has not been compiled or run here.
Before building/publishing a new version:

1. Compile the native app with the documented Android build pipeline.
2. Test A2DP connection before/after launch, wired/USB devices, and two connected
   outputs; verify the Android-selected media sink and disconnect pause behavior.
3. Test call/notification interruptions, focus denial, manual pause during an
   interruption, and reconnect after manual pause.
4. Play long files with screen off/backgrounded for at least 30 minutes on a
   lower-end phone; measure underruns, CPU and battery usage at 44.1/48 kHz.
5. Compare real mono/stereo songs against reference vocal stems, including
   centred instruments, off-centre singers and sustained notes. Evaluate vocal
   damage as well as instrumental leakage; synthetic tests cannot certify quality.
6. Rebuild/sync assets, bump version and update APK hashes only after validation.
