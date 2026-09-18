/* ============================================================
   VocalPure — Isolation Engine v3
   ------------------------------------------------------------
   Splits any song into two stems: 🎤 VOCALS and 🎶 MUSIC.

   What's new in v3 (vs. the old site engine):

   1. CROSSOVER-COHERENT CENTER REMOVAL (stereo)
      The old music stem was "side signal + lowpassed bass" —
      thin and phasey above 150 Hz, and it destroyed every
      centered instrument. v3 uses a Linkwitz-Riley-style 3-way
      crossover:

          low  (< 130 Hz)  : full mix, untouched   (bass & kick)
          mid  (130–9 kHz) : full mix − g·BP(mid)  (voice removed)
          high (> 9 kHz)   : full mix, untouched   (cymbals & air)

      The subtraction happens between signals filtered by the
      IDENTICAL band-pass, so there is no relative phase shift:
      cancellation is exact inside the band and the three bands
      sum to a flat magnitude response. In-band, at g = 1, the
      result is mathematically the side signal (L−R)/2 — but
      unlike the old engine the bass and the top octave keep
      their full stereo mix.

   2. STEREO DETECTION BY CORRELATION
      "Stereo" files whose channels are identical (fake stereo)
      used to collapse the karaoke stem to silence. The engine
      now measures L/R correlation and falls back to the mono
      path automatically.

   3. STEEPER, MATCHED EDGES
      Every band edge is a 2-stage cascade (24 dB/oct). Besides
      tightening the isolation, this makes the low band leak far
      less voice into the accompaniment than the old 1-stage
      filters did.

   4. ADJUSTABLE ISOLATION STRENGTH
      g (the center-removal amount) is a live GainNode, so the
      user can dial the effect from "gentle" to "full karaoke"
      while music plays.

   5. SMOOTH MONO PATH
      Mono songs used to get a hard spectral hole (only <170 Hz
      and >4.3 kHz survived). Now the mono music stem is the
      same 3-way bank with an attenuated mid band:
      low + (1−g)·mid + high — continuous, musical, and the
      cancellation reaches up to 9 kHz (sibilance included).

   6. VOCAL PRESENCE SHAPING
      The vocal stem gets a warmth lift (~210 Hz) and a presence
      lift (~2.9 kHz) after its band limits, so isolated voices
      sound forward and clear instead of muffled.

   Design note: phase coherence is why the removal is applied
   inside the crossover instead of subtracting a filtered signal
   from an unfiltered one — a filtered mid subtracted from the
   raw mix suffers phase rotation at the band edges and can even
   AMPLIFY the voice there (verified numerically in
   tools/checks/test_isolation.mjs).
   ============================================================ */
(function (global) {
  "use strict";

  var DEFAULTS = {
    strength: 0.9,           // 0..1 — center-removal amount (g)
    // stereo crossovers: bass kept below xoverLo, highs kept above xoverHi
    xoverLo: 130,            // Hz
    xoverHi: 9000,           // Hz
    // stereo vocal-stem band limits
    vocalLo: 100,
    vocalHi: 10500,
    // mono crossover / cancellation band
    monoLo: 150,
    monoHi: 9000,
    // mono vocal-stem band limits
    monoVocalLo: 130,
    monoVocalHi: 4600
  };

  function mergeOpts(opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts.hasOwnProperty(k2)) o[k2] = opts[k2];
    return o;
  }

  /* ---- WebAudio node helpers ---- */
  function biquad(C, type, freq, q, dbgain) {
    var f = C.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = (q === undefined ? 0.71 : q);
    if (dbgain !== undefined) f.gain.value = dbgain;
    return f;
  }

  /* A cascade of `stages` identical biquads → 2 stages = 24 dB/oct */
  function cascade(C, type, freq, q, stages) {
    var first = biquad(C, type, freq, q), last = first;
    for (var i = 1; i < stages; i++) {
      var f = biquad(C, type, freq, q);
      last.connect(f);
      last = f;
    }
    return { input: first, output: last };
  }

  /* Band-pass built from two cascades: HP(lo) → LP(hi).
     The same coefficients must be used for the stereo source and
     the mono mid tap so the subtraction stays phase-coherent. */
  function bandpass(C, lo, hi) {
    var hp = cascade(C, "highpass", lo, 0.71, 2);
    var lp = cascade(C, "lowpass", hi, 0.71, 2);
    hp.output.connect(lp.input);
    return { input: hp.input, output: lp.output };
  }

  function gainNode(C, v) {
    var g = C.createGain();
    g.gain.value = v;
    return g;
  }

  /* Mono down-mix tap: a 1-channel gain fed by the source gives
     mid = 0.5·(L+R) for stereo input (WebAudio speaker down-mix),
     or a straight copy for mono input. */
  function midTap(C, src) {
    var g = C.createGain();
    try {
      g.channelCount = 1;
      g.channelCountMode = "explicit";
      g.channelInterpretation = "speakers";
    } catch (e) { /* very old engines: fall back to default */ }
    src.connect(g);
    return g;
  }

  /* ---- stereo analysis ------------------------------------
     Returns true only when the two channels genuinely differ.
     Identical channels (corr ≈ +1) would make a side/cancel
     mix disappear, so they are treated as mono. */
  function analyzeStereo(buffer) {
    if (!buffer || buffer.numberOfChannels < 2) return false;
    var L = buffer.getChannelData(0);
    var R = buffer.getChannelData(1);
    var n = Math.min(L.length, R.length);
    if (!n) return false;
    var step = Math.max(1, Math.floor(n / 48000)); // ~1 s of samples
    var ll = 0, rr = 0, lr = 0;
    for (var i = 0; i < n; i += step) {
      var a = L[i], b = R[i];
      ll += a * a; rr += b * b; lr += a * b;
    }
    if (ll <= 0 || rr <= 0) return false;
    var corr = lr / Math.sqrt(ll * rr);
    return corr < 0.995;
  }

  /* ---- the stem builder ------------------------------------
     Builds the full two-stem graph for `src` inside context `C`
     and returns:
       { vocal, music, setStrength(g), cancelGain, stereo }
     `vocal` and `music` are GainNodes the caller routes onward
     (they carry the separated content; the caller applies mode /
     mute / solo / level gains itself). */
  function buildStems(C, src, stereo, opts) {
    var o = mergeOpts(opts);

    var vocal = gainNode(C, 1);   // caller-driven level
    var music = gainNode(C, 1);
    var live = null;              // the strength-controlled gain

    if (stereo) {
      /* one mid tap shared by both stems (keeps them aligned) */
      var mid = midTap(C, src);

      /* --- VOCAL stem: band-limited mid + presence --- */
      var vhp = cascade(C, "highpass", o.vocalLo, 0.71, 2);
      var vlp = cascade(C, "lowpass", o.vocalHi, 0.71, 2);
      var warmth = biquad(C, "peaking", 210, 0.8, 1.2);
      var presence = biquad(C, "peaking", 2900, 0.9, 2.5);
      var vMake = gainNode(C, 1.45);
      mid.connect(vhp.input);
      vhp.output.connect(vlp.input);
      vlp.output.connect(warmth);
      warmth.connect(presence);
      presence.connect(vMake);
      vMake.connect(vocal);

      /* --- MUSIC stem: 3-way crossover, center removed in mid band ---
         low  = LP(xoverLo)            (bass, untouched)
         high = HP(xoverHi)            (air, untouched)
         midB = BP(xoverLo..xoverHi)   (the vocal band)
         music = low + high + midB(src) + (−g)·midB(mid)
         midB(src) and midB(mid) use identical filters, so the
         subtraction is phase-coherent; at g = 1 the mid band
         becomes exactly the side signal. */
      var low = cascade(C, "lowpass", o.xoverLo, 0.71, 2);
      src.connect(low.input);
      low.output.connect(music);

      var high = cascade(C, "highpass", o.xoverHi, 0.71, 2);
      src.connect(high.input);
      high.output.connect(music);

      var midBandSrc = bandpass(C, o.xoverLo, o.xoverHi);
      src.connect(midBandSrc.input);
      midBandSrc.output.connect(music);

      var midBandMid = bandpass(C, o.xoverLo, o.xoverHi);
      mid.connect(midBandMid.input);
      live = gainNode(C, -o.strength);   // −g, live-adjustable
      midBandMid.output.connect(live);
      live.connect(music);
    } else {
      /* --- MONO path --- */
      /* VOCAL stem: vocal-band focus, steep edges + presence */
      var vhp2 = cascade(C, "highpass", o.monoVocalLo, 0.71, 2);
      var vlp2 = cascade(C, "lowpass", o.monoVocalHi, 0.71, 2);
      var presence2 = biquad(C, "peaking", 2600, 0.9, 3);
      var vMake2 = gainNode(C, 1.55);
      src.connect(vhp2.input);
      vhp2.output.connect(vlp2.input);
      vlp2.output.connect(presence2);
      presence2.connect(vMake2);
      vMake2.connect(vocal);

      /* MUSIC stem: low + (1−g)·mid + high — no spectral hole,
         voice (incl. sibilance up to monoHi) reduced smoothly */
      var lowM = cascade(C, "lowpass", o.monoLo, 0.71, 2);
      src.connect(lowM.input);
      lowM.output.connect(music);

      var highM = cascade(C, "highpass", o.monoHi, 0.71, 2);
      src.connect(highM.input);
      highM.output.connect(music);

      var midM = bandpass(C, o.monoLo, o.monoHi);
      src.connect(midM.input);
      live = gainNode(C, 1 - o.strength);  // (1−g), live-adjustable
      midM.output.connect(live);
      live.connect(music);
    }

    return {
      vocal: vocal,
      music: music,
      stereo: !!stereo,
      cancelGain: live,
      setStrength: function (g) {
        var v = Math.max(0, Math.min(1, Number(g) || 0));
        var target = stereo ? -v : (1 - v);
        try { live.gain.setTargetAtTime(target, C.currentTime, 0.05); }
        catch (e) { live.gain.value = target; }
      }
    };
  }

  /* ---- offline render (WAV export) -------------------------
     Renders one of: "vocals" | "karaoke" | "mix" | "original". */
  function renderStems(buffer, mode, opts) {
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error("offline render unsupported"));
    var o = mergeOpts(opts);
    var stereo = analyzeStereo(buffer);
    var ctx = new OAC(2, Math.max(1, Math.ceil(buffer.duration * buffer.sampleRate + 0.5)), buffer.sampleRate);
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    var stems = buildStems(ctx, src, stereo, o);
    var vG = gainNode(ctx, 1), mG = gainNode(ctx, 1);
    if (mode === "vocals") { vG.gain.value = 1; mG.gain.value = 0; }
    else if (mode === "karaoke") { vG.gain.value = 0; mG.gain.value = 1; }
    else if (mode === "mix") {
      var v = (o.mixV === undefined ? 0.7 : o.mixV);
      var m = (o.mixI === undefined ? 0.7 : o.mixI);
      vG.gain.value = v; mG.gain.value = m;
    }
    stems.vocal.connect(vG);
    stems.music.connect(mG);
    vG.connect(ctx.destination);
    mG.connect(ctx.destination);
    src.start(0);
    return ctx.startRendering().then(function (rendered) {
      try { src.stop(0); } catch (e) { /* already stopped */ }
      return { buffer: rendered, stereo: stereo };
    });
  }

  global.VPIsolator = {
    DEFAULTS: DEFAULTS,
    analyzeStereo: analyzeStereo,
    buildStems: buildStems,
    renderStems: renderStems
  };
})(window);
