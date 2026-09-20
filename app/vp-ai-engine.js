/* ============================================================================
   VocalPure — AI voice engine (v6)   ·   app/vp-ai-engine.js
   ----------------------------------------------------------------------------
   The player plays ONE thing only: the isolated voice. There is no stem/mode
   selector any more — this engine is always on and always removes the music,
   in real time, on the device, offline, for files of any size.

   HOW THE SEPARATION WORKS (everything runs inside an AudioWorklet):

     · Streaming STFT — the incoming audio is cut into 1024-sample frames
       (≈21 ms) every 256 samples (75 % overlap, Hann window). Frame-by-frame
       processing is what makes arbitrarily large songs safe: the engine never
       decodes a file into memory, it only ever sees a 1024-sample window.

     · Per-bin evidence that a bin belongs to a voice, summed in log-odds:
         1. learned spectral profiles — two adaptive per-track profiles (voice
            / music) trained online (EM-style, τ ≈ 0.3 s) from the very song
            being played, initialised with a formant prior and a bass/cymbal
            prior. The longer a song plays, the sharper it gets for that
            specific singer and mix.
         2. spatial coherence — a lead vocal sits in the centre channel, so
            bins whose energy is mid-dominant while the same bin's side energy
            is weak get boosted (skipped automatically for mono material).
         3. pitch / harmonicity — normalised autocorrelation of the band
            limited mid signal tracks F0 (70–400 Hz) with an octave guard, and
            a smooth comb prior rewards bins sitting on its harmonics.
         4. voice-band prior — 150 Hz…4.5 kHz carries intelligibility; sub-bass,
            kick and cymbals are pushed down hard.
         5. frame level voice activity with fast attack / slow release.
       A user-selected steepness turns that into a soft mask, smoothed over
       time and frequency (removes musical noise) and applied to the complex
       spectrum of both channels with the SAME mask, so the voice keeps its
       natural stereo image and reverb.

     · Inverse STFT + overlap-add. Latency: exactly one frame (≈21 ms @48 kHz).

   The processor also reports live metrics to the UI (voice activity, music
   attenuation in dB, detected pitch) and can stream the purified signal to
   the main thread as 16-bit PCM for the WAV export — never buffering a whole
   song in memory.

   The factory is compiled into an AudioWorklet module at runtime from a
   blob: URL, so it works from file:// inside the Android WebView with no
   extra fetch and no CORS. The same function can be called on the main
   thread to read the engine constants / strength presets.
   ========================================================================== */

(function (root) {
  "use strict";

  function VPAIEngineFactory() {
    "use strict";

    /* Strength presets: how hard the mask pushes music down. */
    var AI_STRENGTH = {
      soft:     { steep: 0.85, gate: 0.16, floor: 0.10, label: "Soft" },
      balanced: { steep: 1.35, gate: 0.20, floor: 0.055, label: "Balanced" },
      strong:   { steep: 2.00, gate: 0.26, floor: 0.030, label: "Strong" },
      /* Max / 4K precision: a tighter gate and near-zero residual floor
         prevent quiet instrumental notes from leaking into the vocal. */
      max:      { steep: 4.20, gate: 0.39, floor: 0.004, label: "Max · 4K Precision" }
    };

    var FFT_N = 1024;          /* frame length (≈21 ms @ 48 kHz)              */
    var HOP = 256;             /* 75 % overlap                                */
    var HALF = FFT_N >> 1;     /* 512                                         */
    var NB = HALF - 1;         /* bins 1 … 511 (DC / Nyquist handled apart)   */
    var SR = (typeof sampleRate === "number" && sampleRate > 0) ? sampleRate : 48000;
    var DF = SR / FFT_N;       /* Hz per bin                                   */
    var NOW = (typeof currentTime === "number") ? currentTime : 0;

    /* RBJ biquads (band-pass for pitch detection / per-bin envelope work) */
    function biquad(type, f, q) {
      var w0 = 2 * Math.PI * f / SR, cw = Math.cos(w0), sw = Math.sin(w0);
      var alpha = sw / (2 * q), a0 = 1 + alpha, b0, b1, b2;
      if (type === "lp") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
      else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
      return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
               a1: -2 * cw / a0, a2: (1 - alpha) / a0 };
    }
    function biqRun(co, st, x) {
      var y = co.b0 * x + st.z1;
      st.z1 = co.b1 * x - co.a1 * y + st.z2;
      st.z2 = co.b2 * x - co.a2 * y;
      return y;
    }

    /* ---------------- windows / tables ---------------- */
    var WIN = new Float32Array(FFT_N);
    for (var wi = 0; wi < FFT_N; wi++) WIN[wi] = 0.5 - 0.5 * Math.cos(2 * Math.PI * wi / FFT_N);
    var OLA_GAIN = 1 / 1.5;    /* Σ hann² at 75 % overlap                     */

    var REV = new Uint16Array(FFT_N);
    (function () {
      for (var i = 0; i < FFT_N; i++) {
        var r = 0;
        for (var b = 0; b < 10; b++) if (i & (1 << b)) r |= 1 << (9 - b);
        REV[i] = r;
      }
    })();
    var TW_COS = new Float32Array(HALF), TW_SIN = new Float32Array(HALF);
    for (var tw = 0; tw < HALF; tw++) {
      TW_COS[tw] = Math.cos(-2 * Math.PI * tw / FFT_N);
      TW_SIN[tw] = Math.sin(-2 * Math.PI * tw / FFT_N);
    }

    function fftRun(re, im, inverse) {
      var n = FFT_N, i, k, len, half, stride, j, tr, ti;
      for (i = 0; i < n; i++) {
        j = REV[i];
        if (j > i) {
          tr = re[i]; re[i] = re[j]; re[j] = tr;
          ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
      }
      for (len = 2; len <= n; len <<= 1) {
        half = len >> 1;
        stride = n / len;
        for (i = 0; i < n; i += len) {
          for (k = 0; k < half; k++) {
            var wr = TW_COS[k * stride];
            var sw = TW_SIN[k * stride];
            var wi2 = inverse ? -sw : sw;
            var p = i + k, q = p + half;
            var vr = re[q] * wr - im[q] * wi2;
            var vi = re[q] * wi2 + im[q] * wr;
            re[q] = re[p] - vr; im[q] = im[p] - vi;
            re[p] += vr;        im[p] += vi;
          }
        }
      }
      if (inverse) {
        var s = 1 / n;
        for (i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
      }
    }

    /* ---------------- priors for the adaptive profiles ---------------- */
    function logGauss(f, c, w) {
      var d = Math.log(f / c) / w;
      return Math.exp(-0.5 * d * d);
    }
    function normalize(v) {
      var s = 0, i;
      for (i = 0; i < v.length; i++) s += v[i];
      if (s > 0) { s = 1 / s; for (i = 0; i < v.length; i++) v[i] *= s; }
      return v;
    }
    function makeVoicePrior() {
      var v = new Float32Array(NB), k, f;
      for (k = 0; k < NB; k++) {
        f = (k + 1) * DF;
        v[k] = 0.06
          + 0.75 * logGauss(f, 430, 0.62)     /* body / first formants */
          + 0.34 * logGauss(f, 2600, 0.50)    /* presence              */
          + 0.10 * logGauss(f, 6200, 0.42);   /* breath / sibilance    */
        if (f < 110) v[k] *= 0.25;
        if (f > 11000) v[k] *= 0.4;
      }
      return normalize(v);
    }
    function makeMusicPrior() {
      var v = new Float32Array(NB), k, f;
      for (k = 0; k < NB; k++) {
        f = (k + 1) * DF;
        v[k] = 0.30
          + 0.95 * logGauss(f, 80, 0.55)      /* kick / bass          */
          + 0.42 * logGauss(f, 240, 0.45)     /* low instruments      */
          + 0.34 * logGauss(f, 6800, 0.45);   /* hats / cymbals       */
      }
      return normalize(v);
    }
    function bandPrior() {
      var v = new Float32Array(NB), k, f;
      for (k = 0; k < NB; k++) {
        f = (k + 1) * DF;
        if (f < 90) v[k] = -3.0;
        else if (f < 150) v[k] = -3.0 + 3.5 * (f - 90) / 60;
        else if (f < 4500) v[k] = 0.35;
        else if (f < 5800) v[k] = -0.4;
        else if (f < 9000) v[k] = -1.9;
        else v[k] = -2.8;
      }
      return v;
    }

    /* ======================================================================
       The AudioWorklet processor.
       The class is only *defined* when an AudioWorkletGlobalScope exists, so
       this same factory can also be called on the main thread (it then just
       returns the engine constants / strength presets to the UI).
       ====================================================================== */
    function initProcessor(p) {
      /* ---- stream state ---- */
      p.inL = new Float32Array(FFT_N);
      p.inR = new Float32Array(FFT_N);
      p.hopL = new Float32Array(HOP);
      p.hopR = new Float32Array(HOP);
      p.accL = new Float32Array(FFT_N);
      p.accR = new Float32Array(FFT_N);
      p.fill = 0;

      /* ---- output FIFO: the FFT_N-sample delay line ---- */
      p.fifoSize = FFT_N * 2;
      p.fifoL = new Float32Array(p.fifoSize);
      p.fifoR = new Float32Array(p.fifoSize);
      p.fifoCount = 0;
      p.fifoRead = 0;
      p.fifoWrite = 0;

      /* ---- FFT scratch ---- */
      p.re = new Float64Array(FFT_N);
      p.im = new Float64Array(FFT_N);

      /* ---- spectra / features ---- */
      p.xrL = new Float64Array(HALF + 1);
      p.xiL = new Float64Array(HALF + 1);
      p.xrR = new Float64Array(HALF + 1);
      p.xiR = new Float64Array(HALF + 1);
      p.mag = new Float32Array(HALF + 1);
      p.coh = new Float32Array(HALF + 1);
      p.mask = new Float32Array(HALF + 1);
      p.maskPrev = new Float32Array(HALF + 1);
      p.smoothed = new Float32Array(HALF + 1);
      p.ll = new Float32Array(HALF + 1);
      p.outHopL = new Float32Array(HOP);
      p.outHopR = new Float32Array(HOP);
      /* per-bin fast / slow envelopes → temporal modulation cue */
      p.envFast = new Float32Array(HALF + 1);
      p.envSlow = new Float32Array(HALF + 1);
      p.mod = new Float32Array(HALF + 1);

      /* ---- adaptive profiles ---- */
      p.mV = makeVoicePrior();
      p.mM = makeMusicPrior();
      p.band = bandPrior();

      /* ---- tracking ---- */
      p.vad = 0;
      p.vadSlow = 0;
      p.f0 = 0;
      p.f0Candidate = 0;
      p.f0Hits = 0;
      p.period = 0;
      p.sideRatio = 0.5;
      p.frame = 0;
      p.mono = false;

      /* ---- user parameters ---- */
      p.strength = "balanced";
      p.steep = AI_STRENGTH.balanced.steep;
      p.gateOn = true;
      p.gateTh = AI_STRENGTH.balanced.gate;
      p.floor = AI_STRENGTH.balanced.floor;
      p.capture = false;
      p.bypass = false;

      /* ---- metrics ---- */
      p.sumVad = 0;
      p.statFrames = 0;
      p.cutSum = 0;
      p.cutN = 0;
      p.avgCutDb = 0;
      p.voiceFrames = 0;
      p.musicFrames = 0;
      p.sincePost = 0;

      /* ---- capture buffer for the WAV export ---- */
      p.capL = new Float32Array(HOP * 32);
      p.capR = new Float32Array(HOP * 32);
      p.capFill = 0;
    }

    function setStrength(p, name) {
      var key = AI_STRENGTH[name] ? name : "balanced";
      var preset = AI_STRENGTH[key];
      p.strength = key;
      p.steep = preset.steep;
      p.gateTh = preset.gate;
      p.floor = preset.floor;
      p.port.postMessage({ t: "params", strength: key });
    }

    function resetModels(p) {
      p.mV = makeVoicePrior();
      p.mM = makeMusicPrior();
      p.maskPrev.fill(0);
      p.vad = 0; p.vadSlow = 0; p.f0 = 0; p.period = 0;
      p.frame = 0;
    }

    function clearStream(p) {
      p.inL.fill(0); p.inR.fill(0);
      p.accL.fill(0); p.accR.fill(0);
      p.fifoCount = 0; p.fifoRead = 0; p.fifoWrite = 0;
      p.fill = 0;
      p.vad = 0; p.vadSlow = 0;
    }

    function handleParams(p, e) {
      var d = (e && e.data) || {};
      if (d.t !== "params") return;
      if (d.reset) resetModels(p);
      if (d.strength && AI_STRENGTH[d.strength]) setStrength(p, d.strength);
      if (typeof d.gateOn === "boolean") p.gateOn = d.gateOn;
      if (typeof d.capture === "boolean") p.capture = d.capture;
      if (d.flushCapture) flushCapture(p);
      if (typeof d.bypass === "boolean") p.bypass = d.bypass;
    }

    /* ---- pitch: normalised autocorrelation on a *band-passed* mid signal ----
       A 2nd order high pass at 175 Hz removes the bass/kick (the classic cause
       of a "voiced" false positive: a centred, perfectly periodic bass line)
       and a 2nd order low pass at 3.4 kHz keeps the pitch inside the vocal
       range. The filtered signal is decimated by 4 for a long correlation
       window without the cost of full-rate lags. */
    function pitch(p) {
      var dec = 4, len = 256, lagMin = 30, lagMax = 171, i, j;
      var co0 = p._hp || (p._hp = biquad("hp", 175, 0.707));
      var co1 = p._lp || (p._lp = biquad("lp", 3400, 0.707));
      var st0 = p._hs || (p._hs = { z1: 0, z2: 0 });
      var st1 = p._ls || (p._ls = { z1: 0, z2: 0 });
      var buf = p._pbuf || (p._pbuf = new Float32Array(len));
      var filt = p._filt || (p._filt = new Float32Array(FFT_N));
      for (i = 0; i < FFT_N; i++) {
        var x = (p.inL[i] + p.inR[i]) * 0.5;
        filt[i] = biqRun(co1, st1, biqRun(co0, st0, x));
      }
      var start = FFT_N - len * dec;
      var prevD = filt[start];
      for (i = 0; i < len; i++) {
        var off = start + i * dec;
        var acc2 = 0;
        for (j = 0; j < dec; j++) acc2 += filt[off + j];
        acc2 /= dec;
        buf[i] = acc2 - prevD * 0.0;        /* keep DC out of the correlation */
        prevD = acc2;
      }
      /* remove the local mean so slow envelope drift cannot fake periodicity */
      var mean = 0;
      for (i = 0; i < len; i++) mean += buf[i];
      mean /= len;
      var e0 = 0;
      for (i = 0; i < len; i++) { buf[i] -= mean; e0 += buf[i] * buf[i]; }
      if (e0 < 1e-12) return { corr: 0, f0: 0 };
      var iMax = len - lagMax;
      var best = 0, bestLag = 0;
      for (j = lagMin; j <= lagMax; j++) {
        var num = 0, e1 = 0, e2 = 0;
        for (i = 0; i < iMax; i++) {
          var a = buf[i], b = buf[i + j];
          num += a * b; e1 += a * a; e2 += b * b;
        }
        /* biased normalisation: short lags must not win by having more terms */
        var r = (num / iMax) / (Math.sqrt((e1 / iMax) * (e2 / iMax)) + 1e-12);
        r *= (1 - 1.2 * (j - lagMin) / (lagMax - lagMin));
        if (r > best) { best = r; bestLag = j; }
      }
      if (best <= 0.16 || bestLag === 0) return { corr: Math.max(0, best), f0: 0 };
      var l = bestLag, rp = 0, rn = 0, cp = 0, cn = 0;
      if (l > lagMin && l < lagMax) {
        for (i = 0; i < iMax; i++) {
          rp += buf[i] * buf[i + l - 1]; cp += buf[i + l - 1] * buf[i + l - 1];
          rn += buf[i] * buf[i + l + 1]; cn += buf[i + l + 1] * buf[i + l + 1];
        }
        rp /= Math.sqrt(cp * e0) + 1e-12;
        rn /= Math.sqrt(cn * e0) + 1e-12;
        var den = rp - 2 * best + rn;
        if (Math.abs(den) > 1e-6) l = l + 0.5 * (rp - rn) / den;
      }
      var f0 = SR / (l * dec);
      if (!(f0 > 65 && f0 < 480)) f0 = 0;
      return { corr: Math.max(0, Math.min(1, best)), f0: f0 };
    }

    /* ---------------------------------------------------------------------- */
    function processHop(p) {
      var i, k;

      /* ---- window + packed complex FFT (L in re, R in im) ---- */
      var re = p.re, im = p.im;
      for (i = 0; i < FFT_N; i++) {
        re[i] = p.inL[i] * WIN[i];
        im[i] = p.inR[i] * WIN[i];
      }
      fftRun(re, im, false);

      /* ---- un-tangle: X = (Z + conj(Z[N-k]))/2 ,  Y = -i·(Z - conj(Z[N-k]))/2 ---- */
      var xrL = p.xrL, xiL = p.xiL, xrR = p.xrR, xiR = p.xiR;
      xrL[0] = re[0]; xiL[0] = 0; xrR[0] = im[0]; xiR[0] = 0;
      xrL[HALF] = re[HALF]; xiL[HALF] = 0; xrR[HALF] = im[HALF]; xiR[HALF] = 0;
      for (k = 1; k < HALF; k++) {
        var zr = re[k], zi = im[k];
        var cr = re[FFT_N - k], ci = im[FFT_N - k];
        xrL[k] = 0.5 * (zr + cr);        /* Re L = (Re Z[k] + Re Z[N-k]) / 2 */
        xiL[k] = 0.5 * (zi - ci);        /* Im L = (Im Z[k] - Im Z[N-k]) / 2 */
        xrR[k] = 0.5 * (zi + ci);        /* Re R = (Im Z[k] + Im Z[N-k]) / 2 */
        xiR[k] = 0.5 * (cr - zr);        /* Im R = (Re Z[N-k] - Re Z[k]) / 2 */
      }

      /* ---- per-bin features: magnitude + centre coherence ---- */
      var mag = p.mag, coh = p.coh;
      var a = 0.956;                      /* ≈120 ms smoothing @48 kHz */
      var eVoice = 0, eTot = 0, cohSum = 0, cohW = 0, sideSum = 0;
      for (k = 1; k <= NB; k++) {
        var lr = xrL[k], li = xiL[k], rr = xrR[k], ri = xiR[k];
        var mr = lr + rr, mi = li + ri;          /* 2 · mid  */
        var dr = lr - rr, di = li - ri;          /* 2 · side */
        var mp = mr * mr + mi * mi;
        var sp = dr * dr + di * di;
        var inst = mp / (mp + sp + 1e-12);
        coh[k] = a * coh[k] + (1 - a) * inst;
        var tot = 0.5 * Math.sqrt(mp + sp);
        mag[k] = tot;
        var e = tot * tot, f = k * DF;
        eTot += e; sideSum += sp;
        if (f >= 150 && f <= 4500) { eVoice += e; cohSum += coh[k] * e; cohW += e; }
      }
      mag[0] = 0; mag[HALF] = 0;
      coh[0] = 0.5; coh[HALF] = 0.5;
      /* temporal modulation: speech is syllabic, sustained instruments are not */
      var sumNorm = 0;
      for (k = 1; k <= NB; k++) sumNorm += mag[k];
      if (sumNorm > 1e-9) {
        var inv = 1 / sumNorm;
        for (k = 1; k <= NB; k++) {
          var mn0 = mag[k] * inv;
          p.envFast[k] = p.envFast[k] * 0.70 + mn0 * 0.30;
          p.envSlow[k] = p.envSlow[k] * 0.965 + mn0 * 0.035;
          var dmod = Math.abs(p.envFast[k] - p.envSlow[k]) / (p.envSlow[k] + 1e-6);
          p.mod[k] = dmod > 3 ? 3 : dmod;
        }
      }
      var cohMean = cohW > 0 ? cohSum / cohW : 0.5;
      var bandFocus = eTot > 0 ? eVoice / eTot : 0;
      var modMean = 0;
      for (k = 1; k <= NB; k++) modMean += p.mod[k];
      if (NB) modMean /= NB;
      var sideP = sideSum / (eTot * 4 + 1e-12);        /* side / total power */
      p.sideRatio = 0.995 * p.sideRatio + 0.005 * sideP;
      p.mono = p.sideRatio < 0.02;

      /* ---- pitch tracking with an octave guard ---- */
      var pi = pitch(p);
      p.period = pi.corr;
      if (pi.f0 > 0 && pi.corr > 0.32) {
        if (!p.f0 || Math.abs(pi.f0 - p.f0) / p.f0 < 0.08) {
          p.f0 = p.f0 ? p.f0 * 0.6 + pi.f0 * 0.4 : pi.f0;
          p.f0Hits = 0;
        } else if (p.f0Candidate && Math.abs(pi.f0 - p.f0Candidate) / p.f0Candidate < 0.05) {
          p.f0Hits++;
          if (p.f0Hits >= 2) { p.f0 = pi.f0; p.f0Hits = 0; }
        } else {
          p.f0Candidate = pi.f0; p.f0Hits = 1;
        }
      } else {
        p.f0 *= 0.88;
        if (p.f0 < 40) p.f0 = 0;
      }

      /* ---- frame level voice activity (fast attack, slow release) ---- */
      var spatial = p.mono ? 0.45 : cohMean;
      var target = 0.50 * p.period + 0.28 * spatial + 0.22 * Math.min(1, bandFocus / 0.45);
      if (target > p.vad) p.vad += 0.55 * (target - p.vad);
      else p.vad += 0.07 * (target - p.vad);
      if (p.vad < 0) p.vad = 0; else if (p.vad > 1) p.vad = 1;
      p.vadSlow = p.vadSlow * 0.9 + p.vad * 0.1;

      /* ---- learned log-likelihood ratio, zero-mean over the voice band ---- */
      var ll = p.ll;
      var llMean = 0, llN = 0, ePr = 1e-9;
      for (k = 1; k <= NB; k++) {
        var v = Math.log((p.mV[k - 1] + ePr) / (p.mM[k - 1] + ePr));
        if (v > 2.6) v = 2.6; else if (v < -2.6) v = -2.6;
        ll[k] = v;
        var fq = k * DF;
        if (fq >= 150 && fq <= 4500) { llMean += v; llN++; }
      }
      if (llN) llMean /= llN;

      /* ---- harmonic comb prior around F0 ---- */
      var f0 = p.f0, harmW = p.period > 0.32 ? p.period : 0;
      var tol = 0.035 * f0 + 18;

      /* ---- build the mask (every cue summed in log-odds) ---- */
      var mask = p.mask;
      for (k = 1; k <= NB; k++) {
        var fh = k * DF, h = 0;
        if (harmW > 0 && fh < 6500) {
          var near = Math.round(fh / f0);
          if (near < 1) near = 1;
          var dd = fh - near * f0;
          h = 2 * Math.exp(-(dd * dd) / (tol * tol)) - 0.5;
        }
        var modT = 1.6 * (p.mod[k] - modMean);
        if (modT > 0.95) modT = 0.95; else if (modT < -1.1) modT = -1.1;
        /* only the vocal band may profit from being "syllabic" */
        if (fh < 150) modT *= 0.25;
        else if (fh > 4200) modT *= Math.max(0, 1 - (fh - 4200) / 2200);
        var logit = 1.55 * (ll[k] - llMean)
          + (p.mono ? 0 : 1.30 * (2 * coh[k] - 1) * (0.35 + 0.65 * p.vad))
          + 0.70 * h * harmW
          + modT
          + 1.00 * p.band[k - 1]
          + 1.40 * (p.vad - 0.45);
        mask[k] = 1 / (1 + Math.exp(-logit * p.steep));
      }
      mask[0] = p.floor;
      mask[HALF] = p.floor;

      /* ---- gate music-only sections down to silence ---- */
      if (p.gateOn) {
        var g = (p.vad - p.gateTh * 0.4) / (p.gateTh + 0.30);
        g = g < 0 ? 0 : (g > 1 ? 1 : g);
        g = g * g * (3 - 2 * g);
        for (k = 0; k <= HALF; k++) mask[k] *= g;
      }

      /* ---- 3-tap frequency smoothing + temporal smoothing ---- */
      var smoothed = p.smoothed;
      for (k = 1; k <= NB; k++) {
        var km = k > 1 ? mask[k - 1] : mask[k];
        var kp = k < NB ? mask[k + 1] : mask[k];
        smoothed[k] = 0.25 * km + 0.5 * mask[k] + 0.25 * kp;
      }
      smoothed[0] = mask[0]; smoothed[HALF] = mask[HALF];
      var cut = 0, cutN = 0;
      for (k = 0; k <= HALF; k++) {
        var kept = p.maskPrev[k] * 0.55 + smoothed[k] * 0.45;
        if (kept < p.floor) kept = p.floor;
        p.maskPrev[k] = kept;
        smoothed[k] = p.bypass ? 1 : kept;
        if (k > 0 && k < HALF && mag[k] > 1e-7) {
          cut += 10 * Math.log10(kept * kept + 1e-6) * mag[k];
          cutN += mag[k];
        }
      }
      if (cutN > 0) { p.cutSum += cut / cutN; p.cutN++; }

      /* ---- apply the mask, re-pack and inverse transform ---- */
      for (k = 0; k <= HALF; k++) {
        var gg = smoothed[k];
        xrL[k] *= gg; xiL[k] *= gg;
        xrR[k] *= gg; xiR[k] *= gg;
      }
      /* Z'[k] = L[k] + i·R[k]  →  Re Z' = Re L - Im R ,  Im Z' = Re R + Im L
         (the mask is real and identical for both parts, so scaling L and R
         before this step is the same as scaling Z'). */
      re[0] = xrL[0]; im[0] = xrR[0];
      re[HALF] = xrL[HALF]; im[HALF] = xrR[HALF];
      for (k = 1; k < HALF; k++) {
        re[k] = xrL[k] - xiR[k];
        im[k] = xrR[k] + xiL[k];
        /* negative-frequency half: conj(L[k]) + i·conj(R[k]) */
        re[FFT_N - k] = xrL[k] + xiR[k];
        im[FFT_N - k] = xrR[k] - xiL[k];
      }
      fftRun(re, im, true);
      for (i = 0; i < FFT_N; i++) {
        p.accL[i] += re[i] * WIN[i] * OLA_GAIN;
        p.accR[i] += im[i] * WIN[i] * OLA_GAIN;
      }

      /* ---- online learning of the two spectral profiles ---- */
      var sumMag = 0;
      for (k = 1; k <= NB; k++) sumMag += mag[k];
      if (sumMag > 1e-7) {
        var sc = 1 / sumMag;
        var trainVoice = p.vad > 0.16, trainMusic = true;
        var etaV = 0.022, etaM = 0.028;
        for (k = 1; k <= NB; k++) {
          var mn = mag[k] * sc;
          var r = smoothed[k];
          if (trainVoice) {
            /* bins that are steady (sustained instruments) must not be learned
               into the voice profile just because the frame is "voiced" */
            var mf = p.mod[k] / (modMean + 0.05);
            if (mf > 1.5) mf = 1.5; else if (mf < 0) mf = 0;
            p.mV[k - 1] += etaV * r * mf * (mn - p.mV[k - 1]);
          }
          if (trainMusic) p.mM[k - 1] += etaM * (1 - r) * (mn - p.mM[k - 1]);
        }
        if ((p.frame & 15) === 0) { normalize(p.mV); normalize(p.mM); }
      }

      /* ---- emit exactly one hop ---- */
      for (i = 0; i < HOP; i++) {
        p.outHopL[i] = p.accL[i];
        p.outHopR[i] = p.accR[i];
      }
      p.accL.copyWithin(0, HOP); p.accL.fill(0, FFT_N - HOP);
      p.accR.copyWithin(0, HOP); p.accR.fill(0, FFT_N - HOP);

      p.frame++;
      p.statFrames++;
      p.sincePost++;
      p.sumVad += p.vad;
      if (p.vad > 0.35) p.voiceFrames++;
      else if (p.vad < 0.12) p.musicFrames++;
      if (p.capture) pushCapture(p);
    }

    /* ---------------- 16-bit capture for the WAV export ---------------- */
    function pushCapture(p) {
      var n = p.capFill;
      if (n + HOP > p.capL.length) { flushCapture(p); n = p.capFill; }
      p.capL.set(p.outHopL, n);
      p.capR.set(p.outHopR, n);
      p.capFill = n + HOP;
      if (p.capFill >= p.capL.length) flushCapture(p);
    }

    function flushCapture(p) {
      var n = p.capFill;
      if (!n) return;
      var buf = new ArrayBuffer(n * 4);
      var view = new DataView(buf);
      var o = 0, i;
      for (i = 0; i < n; i++) {
        var l = p.capL[i], r = p.capR[i];
        l = l < -1 ? -1 : (l > 1 ? 1 : l);
        r = r < -1 ? -1 : (r > 1 ? 1 : r);
        view.setInt16(o, l < 0 ? l * 0x8000 : l * 0x7fff, true); o += 2;
        view.setInt16(o, r < 0 ? r * 0x8000 : r * 0x7fff, true); o += 2;
      }
      p.capFill = 0;
      p.port.postMessage({ t: "pcm", samples: n, data: buf }, [buf]);
    }

    /* ---------------- live metrics for the UI ---------------- */
    var STAT_EVERY = Math.max(4, Math.round(0.25 * SR / HOP));
    function postStats(p) {
      if (p.sincePost < STAT_EVERY) return;
      p.sincePost = 0;
      var frames = p.statFrames || 1;
      p.avgCutDb = p.cutN ? p.cutSum / p.cutN : p.avgCutDb;
      p.port.postMessage({
        t: "stats",
        engine: "vp-ai-v6",
        strength: p.strength,
        voice: p.sumVad / frames,
        cutDb: p.avgCutDb,
        f0: p.f0,
        vad: p.vad,
        mono: p.mono,
        /* frames analysed since the previous report (not a running total) */
        frames: frames,
        latencyMs: (FFT_N / SR) * 1000
      });
      p.sumVad = 0;
      p.statFrames = 0;
      p.cutSum = 0;
      p.cutN = 0;
    }

    /* ---------------- the render callback ---------------- */
    function processImpl(p, inputs, outputs) {
      var out = outputs[0];
      var inCh = (inputs && inputs[0]) || [];
      if (!out || !out.length) return true;

      if (!inCh.length || !inCh[0]) {
        /* nothing connected / nothing playing: flush and stay silent */
        if (p.frame || p.fill) clearStream(p);
        for (var c = 0; c < out.length; c++) out[c].fill(0);
        return true;
      }

      var inL = inCh[0];
      var inR = inCh.length > 1 && inCh[1] ? inCh[1] : inCh[0];
      var n = out[0].length;
      var i, j;

      for (i = 0; i < n; i++) {
        p.hopL[p.fill] = inL[i];
        p.hopR[p.fill] = inR[i];
        p.fill++;
        if (p.fill === HOP) {
          p.inL.copyWithin(0, HOP);
          p.inR.copyWithin(0, HOP);
          p.inL.set(p.hopL, FFT_N - HOP);
          p.inR.set(p.hopR, FFT_N - HOP);
          p.fill = 0;
          processHop(p);
          /* the finished hop enters the delay line */
          for (j = 0; j < HOP; j++) {
            p.fifoL[p.fifoWrite] = p.outHopL[j];
            p.fifoR[p.fifoWrite] = p.outHopR[j];
            p.fifoWrite = (p.fifoWrite + 1) % p.fifoSize;
            if (p.fifoCount < p.fifoSize) p.fifoCount++;
          }
        }
        if (p.fifoCount > 0) {
          out[0][i] = p.fifoL[p.fifoRead];
          if (out.length > 1) out[1][i] = p.fifoR[p.fifoRead];
          p.fifoRead = (p.fifoRead + 1) % p.fifoSize;
          p.fifoCount--;
        } else {
          out[0][i] = 0;
          if (out.length > 1) out[1][i] = 0;
        }
      }
      postStats(p);
      return true;
    }

    var VoiceProcessor = null;
    if (typeof AudioWorkletProcessor === "function") {
      VoiceProcessor = class VoiceProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          initProcessor(this);
          var self = this;
          this.port.onmessage = function (e) { handleParams(self, e); };
          this.port.postMessage({
            t: "ready",
            engine: "vp-ai-v6",
            sr: SR,
            fft: FFT_N,
            hop: HOP,
            latencyMs: (FFT_N / SR) * 1000,
            strengths: Object.keys(AI_STRENGTH)
          });
        }
        process(inputs, outputs) { return processImpl(this, inputs, outputs); }
      };
      registerProcessor("vp-ai-voice", VoiceProcessor);
    }

    return {
      processor: VoiceProcessor,
      strengths: AI_STRENGTH,
      engine: "vp-ai-v6",
      fftN: FFT_N,
      hop: HOP,
      sampleRate: SR,
      latencyMs: (FFT_N / SR) * 1000
    };
  }

  root.VPAIEngineFactory = VPAIEngineFactory;

  /* Main-thread view of the engine constants (no AudioWorklet needed). */
  var api = null;
  try { api = VPAIEngineFactory(); } catch (e) { api = null; }
  root.VPAIEngine = {
    factory: VPAIEngineFactory,
    info: api,
    strengths: api ? api.strengths : { soft: { label: "Soft" }, balanced: { label: "Balanced" }, strong: { label: "Strong" }, max: { label: "Max" } }
  };
})(typeof self !== "undefined" ? self : this);
