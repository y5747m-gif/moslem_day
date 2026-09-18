#!/usr/bin/env node
/* ============================================================
   Numeric verification of the VocalPure v3 isolation engine.
   ------------------------------------------------------------
   Re-implements, in plain JS, the exact filter graphs used by
   app/js/isolation.js (RBJ biquads, same types / frequencies /
   Q / cascades) and compares them against the OLD site engine:

     OLD music stem (stereo):  side signal + lowpassed(<150 Hz) mid
     NEW music stem (stereo):  3-way LR-style crossover
                               low + high untouched, mid band gets
                               BP(L) - g*BP(mid)  (phase-coherent)

   Test signal: a synthetic "song" — centered voice (220 Hz–2.6 kHz
   + harmonics), centered bass (55–110 Hz), a centered hi-shimmer
   tone above the crossover (9.5 kHz), and instruments panned hard
   left / right. Energies are measured with Goertzel at the exact
   synthesis frequencies.
   ============================================================ */
"use strict";

var SR = 44100;

/* ---- RBJ audio-EQ-cookbook biquad ---- */
function biquadCoeffs(type, f0, Q, dbGain) {
  var A = Math.pow(10, (dbGain || 0) / 40);
  var w0 = 2 * Math.PI * f0 / SR;
  var cw = Math.cos(w0), sw = Math.sin(w0);
  var alpha = sw / (2 * Q);
  var b0, b1, b2, a0, a1, a2;
  if (type === "highpass") {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === "lowpass") {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === "peaking") {
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else throw new Error("type " + type);
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function makeBiquad(type, f0, Q, dbGain) {
  var c = biquadCoeffs(type, f0, Q, dbGain);
  var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return function (x) {
    var y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}
function makeCascade(n, type, f0, Q, dbGain) {
  var fns = [];
  for (var i = 0; i < n; i++) fns.push(makeBiquad(type, f0, Q, dbGain));
  return function (x) { for (var i = 0; i < n; i++) x = fns[i](x); return x; };
}
function makeBandpass(lo, hi) {
  var hp = makeCascade(2, "highpass", lo, 0.71);
  var lp = makeCascade(2, "lowpass", hi, 0.71);
  return function (x) { return lp(hp(x)); };
}

/* ---- exact tone energy via Goertzel ---- */
function tonePower(x, f) {
  var n = x.length;
  var k = Math.round(f * n / SR);
  var w = 2 * Math.PI * k / n;
  var coeff = 2 * Math.cos(w);
  var s0 = 0, s1 = 0, s2 = 0;
  for (var i = 0; i < n; i++) {
    s0 = x[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  var power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
  return power / 2; // mean square of the sinusoid component
}
function bandPower(x, freqs) {
  var t = 0;
  for (var i = 0; i < freqs.length; i++) t += tonePower(x, freqs[i]);
  return t;
}
function db(r) { return 10 * Math.log10(Math.max(r, 1e-30)); }

/* ---- the NEW v3 graphs (mirror of isolation.js constants) ---- */
var XLO = 130, XHI = 9000, VLO = 100, VHI = 10500;
var MLO = 150, MHI = 9000, MVLO = 130, MVHI = 4600;

function newMusicStereo(L, R, g) {
  var n = L.length;
  /* each channel gets its OWN filter instances (WebAudio processes
     stereo channels with independent state — closures do not) */
  var lowL = makeCascade(2, "lowpass", XLO, 0.71), lowR = makeCascade(2, "lowpass", XLO, 0.71);
  var highL = makeCascade(2, "highpass", XHI, 0.71), highR = makeCascade(2, "highpass", XHI, 0.71);
  var bpSrcL = makeBandpass(XLO, XHI), bpSrcR = makeBandpass(XLO, XHI);
  var bpMid = makeBandpass(XLO, XHI); // identical coefficients
  var outL = new Float64Array(n), outR = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    var mid = 0.5 * (L[i] + R[i]);
    var c = bpMid(mid); // advance the mid filter ONCE per sample (fan-out)
    outL[i] = lowL(L[i]) + highL(L[i]) + bpSrcL(L[i]) - g * c;
    outR[i] = lowR(R[i]) + highR(R[i]) + bpSrcR(R[i]) - g * c;
  }
  return [outL, outR];
}
function newMusicMono(M, g) {
  var n = M.length;
  var low = makeCascade(2, "lowpass", MLO, 0.71);
  var high = makeCascade(2, "highpass", MHI, 0.71);
  var mid = makeBandpass(MLO, MHI);
  var out = new Float64Array(n);
  for (var i = 0; i < n; i++) out[i] = low(M[i]) + high(M[i]) + (1 - g) * mid(M[i]);
  return out;
}
function newVocalStereo(L, R) {
  var n = L.length;
  var hp = makeCascade(2, "highpass", VLO, 0.71);
  var lp = makeCascade(2, "lowpass", VHI, 0.71);
  var warm = makeBiquad("peaking", 210, 0.8, 1.2);
  var pres = makeBiquad("peaking", 2900, 0.9, 2.5);
  var out = new Float64Array(n);
  for (var i = 0; i < n; i++) out[i] = 1.45 * pres(warm(lp(hp(0.5 * (L[i] + R[i])))));
  return out;
}

/* ---- the OLD graphs (from the previous js/app.js) ---- */
function oldMusicStereo(L, R) {
  var n = L.length;
  var lp = makeBiquad("lowpass", 150, 0.71);
  var outL = new Float64Array(n), outR = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    var bass = 0.85 * lp(0.5 * (L[i] + R[i]));
    outL[i] = 1.15 * 0.5 * (L[i] - R[i]) + bass;
    outR[i] = 1.15 * 0.5 * (R[i] - L[i]) + bass;
  }
  return [outL, outR];
}
function oldMusicMono(M) {
  var n = M.length;
  var lo = makeBiquad("lowpass", 170, 0.71);
  var hi = makeBiquad("highpass", 4300, 0.71);
  var out = new Float64Array(n);
  for (var i = 0; i < n; i++) out[i] = 1.25 * lo(M[i]) + 1.25 * hi(M[i]);
  return out;
}

/* ---- the test "song" ---- */
var VOICE = [220, 330, 440, 550, 660, 880, 1100, 1320, 1760, 2200, 2640];
var VOICE_CORE = [330, 440, 550, 660, 880, 1100, 1320, 1760, 2200, 2640]; // >= 1 octave above xover
var BASS = [55, 82, 110];
var SHIMMER = 11000;                // centered, above the crossover
var SPARKLE = 14000;               // centered, deep above the vocal band
var INST_L = [196, 294, 392, 588];  // panned hard left
var INST_R = [185, 277, 370, 555];  // panned hard right

function makeSong(seconds, mono) {
  var n = Math.floor(seconds * SR);
  var L = new Float64Array(n), R = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    var t = i / SR;
    var voice = 0, bass = 0, gl = 0, gr = 0, shim = 0;
    for (var v = 0; v < VOICE.length; v++)
      voice += (0.35 / (v + 1)) * Math.sin(2 * Math.PI * VOICE[v] * t + v);
    for (var b = 0; b < BASS.length; b++)
      bass += (0.40 / (b + 1)) * Math.sin(2 * Math.PI * BASS[b] * t + b);
    for (var a = 0; a < INST_L.length; a++)
      gl += (0.30 / (a + 1)) * Math.sin(2 * Math.PI * INST_L[a] * t + a * 1.3);
    for (var c = 0; c < INST_R.length; c++)
      gr += (0.30 / (c + 1)) * Math.sin(2 * Math.PI * INST_R[c] * t + c * 2.1);
    shim = 0.12 * Math.sin(2 * Math.PI * SHIMMER * t) + 0.10 * Math.sin(2 * Math.PI * SPARKLE * t);
    if (mono) {
      var m = voice + bass + (gl + gr) * 0.5 + shim;
      L[i] = m; R[i] = m;
    } else {
      L[i] = voice + bass + gl + shim;
      R[i] = voice + bass + gr + shim;
    }
  }
  return [L, R];
}

/* ================= run ================= */
var fails = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!cond) fails++;
}

var G = 0.9; // default strength 90%

console.log("== stereo song: music (karaoke) stem ==");
var song = makeSong(4.0, false);
var L = song[0], R = song[1];
var newK = newMusicStereo(L, R, G);
var oldK = oldMusicStereo(L, R);

var vIn = bandPower(L, VOICE);
var vNew = bandPower(newK[0], VOICE);
var vOld = bandPower(oldK[0], VOICE);
check("NEW suppresses centered voice by > 12 dB (full band)", db(vIn / vNew) > 12, "-" + db(vIn / vNew).toFixed(1) + " dB");
check("OLD suppressed it too (reference)", db(vIn / vOld) > 8, "-" + db(vIn / vOld).toFixed(1) + " dB");
var vcNew = bandPower(newK[0], VOICE_CORE);
var vcOld = bandPower(oldK[0], VOICE_CORE);
check("NEW core-band suppression is comparable to OLD (within 6 dB)", db(vcNew / vcOld) < 6,
  "new -" + db(vIn / vcNew).toFixed(1) + " dB vs old -" + db(vIn / vcOld).toFixed(1) + " dB");

var bIn = bandPower(L, BASS);
var bNew = bandPower(newK[0], BASS);
var bOld = bandPower(oldK[0], BASS);
check("NEW keeps the bass (loss < 1 dB)", db(bIn / bNew) < 1, "-" + db(bIn / bNew).toFixed(1) + " dB");
check("NEW bass retention beats OLD", db(bNew / bOld) > 0, "new -" + db(bIn / bNew).toFixed(1) + " vs old -" + db(bIn / bOld).toFixed(1) + " dB");

var sIn = tonePower(L, SHIMMER);
var sNew = tonePower(newK[0], SHIMMER);
var sOld = tonePower(oldK[0], SHIMMER);
check("NEW keeps the centered 11 kHz shimmer (loss < 3.5 dB)", db(sIn / sNew) < 3.5, "-" + db(sIn / sNew).toFixed(1) + " dB");
check("OLD destroys the shimmer (> 20 dB loss)", db(sIn / sOld) > 20, "-" + db(sIn / sOld).toFixed(1) + " dB");
check("NEW high-band retention beats OLD by > 15 dB", db(sNew / sOld) > 15, "+" + db(sNew / sOld).toFixed(1) + " dB");

var iIn = bandPower(L, INST_L);
var iNew = bandPower(newK[0], INST_L);
var iOld = bandPower(oldK[0], INST_L);
check("NEW keeps panned instruments within 3 dB of OLD", db(iNew / iOld) > -3, db(iNew / iOld).toFixed(1) + " dB rel");

console.log("== adjustable strength (g sweep) ==");
var weak = newMusicStereo(L, R, 0.3)[0];
var vWeak = bandPower(weak, VOICE);
check("g=0.3 gives gentle cancellation (2–9 dB)", db(vIn / vWeak) > 2 && db(vIn / vWeak) < 9, "-" + db(vIn / vWeak).toFixed(1) + " dB");
var full = newMusicStereo(L, R, 1.0)[0];
var vFull = bandPower(full, VOICE_CORE);
check("g=1.0 gives near-total core-band removal (> 20 dB)", db(vIn / vFull) > 20, "-" + db(vIn / vFull).toFixed(1) + " dB");

console.log("== mono song: music (karaoke) stem ==");
var mono = makeSong(4.0, true);
var M = mono[0];
var vmIn = bandPower(M, VOICE);
var newKM = newMusicMono(M, G);
var oldKM = oldMusicMono(M);
var vmNew = bandPower(newKM, VOICE);
var vmOld = bandPower(oldKM, VOICE);
check("NEW mono suppresses the voice band by > 10 dB", db(vmIn / vmNew) > 10, "-" + db(vmIn / vmNew).toFixed(1) + " dB");
check("NEW mono beats OLD mono on voice suppression", db(vmNew / vmOld) < 0, "new -" + db(vmIn / vmNew).toFixed(1) + " vs old -" + db(vmIn / vmOld).toFixed(1) + " dB");
var bmIn = bandPower(M, BASS);
var bmNew = bandPower(newKM, BASS);
check("NEW mono keeps the bass (loss < 3 dB)", db(bmIn / bmNew) < 3, "-" + db(bmIn / bmNew).toFixed(1) + " dB");
var smIn = tonePower(M, SHIMMER);
var smNew = tonePower(newKM, SHIMMER);
check("NEW mono keeps content above the band (loss < 3.5 dB)", db(smIn / smNew) < 3.5, "-" + db(smIn / smNew).toFixed(1) + " dB");

console.log("== vocal stem (stereo) ==");
var vocal = newVocalStereo(L, R);
var vvIn = bandPower(L, VOICE);
var vvOut = bandPower(vocal, VOICE);
var vbIn = bandPower(L, BASS);
var vbOut = bandPower(vocal, BASS);
check("vocal stem amplifies the voice band (> 0 dB vs song)", db(vvOut / vvIn) > 0, "+" + db(vvOut / vvIn).toFixed(1) + " dB");
check("vocal stem rejects the bass by > 8 dB", db(vbIn / vbOut) > 8, "-" + db(vbIn / vbOut).toFixed(1) + " dB");
var spIn = tonePower(L, SPARKLE);
var spOut = tonePower(vocal, SPARKLE);
check("vocal stem attenuates content far above its band (> 6 dB)", db(spIn / spOut) > 6, "-" + db(spIn / spOut).toFixed(1) + " dB");

console.log("");
if (fails) {
  console.error(fails + " check(s) FAILED");
  process.exit(1);
}
console.log("All isolation checks passed.");
