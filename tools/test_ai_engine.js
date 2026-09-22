#!/usr/bin/env node
/* ============================================================================
   VocalPure — AI engine test-suite  ·  tools/test_ai_engine.js
   ----------------------------------------------------------------------------
   Runs the real AudioWorklet DSP (app/vp-ai-engine.js) inside Node by shimming
   the AudioWorkletGlobalScope, then measures what the engine actually does:

     1. no unity-mask backdoor — a stale bypass:true must NOT yield passthrough
     2. music-only sections    — must collapse to (near) silence
     3. instrument suppression — bass / hats / wide pad must be cut hard
     4. voice retention        — the centred voice must survive
     5. realtime head-room     — how much faster than realtime it runs

   Usage:  node tools/test_ai_engine.js
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app", "vp-ai-engine.js"), "utf8");

let failures = 0;
function check(name, ok, detail) {
  const tag = ok ? "  ✓ " : "  ✗ ";
  console.log(tag + name + (detail ? "   [" + detail + "]" : ""));
  if (!ok) failures++;
}
function round(v, d) { const p = Math.pow(10, d || 2); return Math.round(v * p) / p; }
function dB(x) { return 10 * Math.log10(Math.max(x, 1e-20)); }

/* ---------------------------------------------------------------- shim host */
function loadEngine(sampleRate) {
  const messages = [];
  const registered = {};
  const ctx = vm.createContext({
    sampleRate,
    currentTime: 0,
    console,
    Math, JSON, Object, Array, Float32Array, Float64Array, Uint16Array, Int16Array,
    ArrayBuffer, DataView, isFinite, isNaN, parseFloat, parseInt, Infinity, NaN,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage: (m) => messages.push(m),
          onmessage: null
        };
      }
    },
    registerProcessor: (name, cls) => { registered[name] = cls; }
  });
  vm.runInContext(SRC + "\n;globalThis.__api = VPAIEngineFactory();", ctx, { filename: "vp-ai-engine.js" });
  const api = ctx.__api;
  if (!registered["vp-ai-voice"]) throw new Error("processor was not registered");
  return { api, Processor: registered["vp-ai-voice"], messages, ctx };
}

/* -------------------------------------------------------- signal generators */
function makeSignals(sr, seconds) {
  const n = Math.floor(sr * seconds);
  const mixL = new Float32Array(n), mixR = new Float32Array(n);
  const voiceL = new Float32Array(n), voiceR = new Float32Array(n);
  const musicL = new Float32Array(n), musicR = new Float32Array(n);

  const VOICE_START = 4.0, VOICE_END = 10.0;
  const f0 = 165;
  let phase = 0, hatPhase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;

    /* ---- "voice": harmonic stack shaped like a formant envelope, centre ---- */
    let v = 0;
    if (t >= VOICE_START && t < VOICE_END) {
      const syll = (t - VOICE_START) % 0.75;
      const env = syll < 0.52 ? Math.min(1, syll / 0.05) * Math.min(1, (0.52 - syll) / 0.06) : 0;
      const f = f0 * (1 + 0.03 * Math.sin(2 * Math.PI * 3.1 * t));   /* vibrato */
      phase += 2 * Math.PI * f / sr;
      if (phase > Math.PI * 2) phase -= Math.PI * 2;
      for (let h = 1; h <= 26; h++) {
        const fh = h * f0;
        if (fh > 4600) break;
        const env1 = Math.exp(-0.5 * Math.pow(Math.log(fh / 620) / 0.55, 2));
        const env2 = 0.4 * Math.exp(-0.5 * Math.pow(Math.log(fh / 2500) / 0.4, 2));
        v += (env1 + env2) / h * Math.sin(h * phase);
      }
      v *= 0.5 * env;
    }
    voiceL[i] = v; voiceR[i] = v;

    /* ---- "music": bass + wide pad + hats, none of it centre-locked ---- */
    const bass = 0.42 * Math.sin(2 * Math.PI * 92 * t) + 0.22 * Math.sin(2 * Math.PI * 46 * t);
    const padA = 0.16 * Math.sin(2 * Math.PI * 392 * t + 0.4);
    const padB = 0.14 * Math.sin(2 * Math.PI * 587 * t + 1.1);
    const padC = 0.12 * Math.sin(2 * Math.PI * 784 * t + 2.3);
    /* pads are side-heavy: opposite polarity + phase spread */
    const padL = padA + 0.6 * padB + 0.4 * padC;
    const padR = -0.9 * padA + 0.5 * padB - 0.7 * padC;
    /* hats: 8 kHz bursts, panned hard left/right alternately */
    hatPhase += 2 * Math.PI * 8200 / sr;
    const hatEnv = Math.exp(-((t % 0.25) * 45));
    const hat = 0.20 * hatEnv * Math.sin(hatPhase);
    const mL = bass + padL + hat;
    const mR = bass + padR - hat;
    musicL[i] = mL; musicR[i] = mR;

    mixL[i] = v + mL;
    mixR[i] = v + mR;
  }
  return { mixL, mixR, voiceL, voiceR, musicL, musicR, voiceStart: VOICE_START, voiceEnd: VOICE_END, sr, n };
}

/* ------------------------------------------------------------ run the engine */
function run(Processor, sig, opts) {
  const sr = sig.sr;
  const proc = new Processor();
  const strength = (opts && opts.strength) || "balanced";
  const params = { t: "params", strength, gateOn: !(opts && opts.gateOff), bypass: !!(opts && opts.bypass) };
  proc.port.onmessage && proc.port.onmessage({ data: params });
  /* the real app sends params right after construction; emulate both paths */
  proc.port.postMessage({ t: "noop" });
  const BLOCK = 128;
  const outL = new Float32Array(sig.n);
  const outR = new Float32Array(sig.n);
  const inL = new Float32Array(BLOCK), inR = new Float32Array(BLOCK);
  const blockL = new Float32Array(BLOCK), blockR = new Float32Array(BLOCK);
  for (let off = 0; off < sig.n; off += BLOCK) {
    const len = Math.min(BLOCK, sig.n - off);
    for (let i = 0; i < len; i++) { inL[i] = sig.L[off + i]; inR[i] = sig.R[off + i]; }
    const inputs = [[inL.subarray(0, len), inR.subarray(0, len)]];
    const outputs = [[blockL.subarray(0, len), blockR.subarray(0, len)]];
    proc.process(inputs, outputs);
    for (let i = 0; i < len; i++) { outL[off + i] = blockL[i]; outR[off + i] = blockR[i]; }
  }
  return { outL, outR, latencyFrames: 1024 - 1, proc };
}

function energy(arr, from, to) {
  let e = 0;
  const a = Math.max(0, Math.floor(from)), b = Math.min(arr.length, Math.floor(to));
  for (let i = a; i < b; i++) e += arr[i] * arr[i];
  return e / Math.max(1, b - a);
}

/* direct DFT band energy (mean power over a set of probe frequencies) */
function bandEnergy(arr, sr, from, to, fLo, fHi) {
  from = Math.floor(from); to = Math.floor(to);
  const probes = 14, len = to - from;
  let e = 0;
  for (let q = 0; q < probes; q++) {
    const f = fLo + (fHi - fLo) * (q / (probes - 1));
    const w = 2 * Math.PI * f / sr;
    let re = 0, im = 0;
    for (let i = from; i < to; i++) {
      const x = arr[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (i - from) / len));
      re += x * Math.cos(w * i);
      im += x * Math.sin(w * i);
    }
    e += (re * re + im * im) / (len * len) * 4;
  }
  return e / probes;
}

/* ========================================================================== */
console.log("VocalPure AI engine — DSP test-suite\n");

const SR = 48000;
const { api, Processor, messages } = loadEngine(SR);
check("engine registers an AudioWorkletProcessor", !!Processor);
check("engine reports its identity", api.engine === "vp-ai-v6" || api.engine === "vp-ai-v7-pro", api.engine);
check("latency is one FFT frame", round(api.latencyMs, 1) === round(1024 / SR * 1000, 1), round(api.latencyMs, 2) + " ms");
check("strength presets exposed", Object.keys(api.strengths).join(",") === "soft,balanced,strong,max");
{
  new Processor();
  check("worklet announces itself as ready", messages.some(m => m.t === "ready"));
}

/* ---------------- 1. no unity-mask backdoor ---------------- */
{
  // The old bypass flag (mask forced to unity) was removed so that unfiltered
  // music can never leak through this node. A stale or compromised client
  // that still sends bypass:true must NOT get transparent audio back:
  // music-only input must come out attenuated just the same.
  const probe = makeSignals(SR, 6);
  const r = run(Processor, { L: probe.mixL, R: probe.mixR, sr: SR, n: probe.n },
    { strength: "strong", bypass: true });
  const d = 1023;
  const seg = [d + SR * 1.0, d + SR * 3.5];
  const inE = energy(probe.mixL, seg[0] - d, seg[1] - d) + energy(probe.mixR, seg[0] - d, seg[1] - d);
  const outE = energy(r.outL, seg[0], seg[1]) + energy(r.outR, seg[0], seg[1]);
  const att = dB(outE / inE);
  check("no unity-mask backdoor (bypass:true still separates)", att < -20, "attenuation " + round(att, 1) + " dB");
}
console.log("");

/* ---------------- 2-4. separation quality ---------------- */
const sig = makeSignals(SR, 14);
const mixR = run(Processor, { L: sig.mixL, R: sig.mixR, sr: SR, n: sig.n }, { strength: "strong" });
const voiceOnly = run(Processor, { L: sig.voiceL, R: sig.voiceR, sr: SR, n: sig.n }, { strength: "strong" });
const musicOnly = run(Processor, { L: sig.musicL, R: sig.musicR, sr: SR, n: sig.n }, { strength: "strong" });

const D = 1023;   /* measured engine latency: FFT_N - 1 samples */
const musicSeg = [D + SR * 1.0, D + SR * 3.5];                          /* music only  */
const bothSeg = [D + SR * 5.0, D + SR * 9.5];                           /* voice+music */
const voiceSeg = [D + SR * 5.0, D + SR * 9.5];

const mixBoth = energy(sig.mixL, bothSeg[0] - D, bothSeg[1] - D) + energy(sig.mixR, bothSeg[0] - D, bothSeg[1] - D);
const outBoth = energy(mixR.outL, bothSeg[0], bothSeg[1]) + energy(mixR.outR, bothSeg[0], bothSeg[1]);
const outVoiceRef = energy(voiceOnly.outL, voiceSeg[0], voiceSeg[1]) + energy(voiceOnly.outR, voiceSeg[0], voiceSeg[1]);
const outMusicRef = energy(musicOnly.outL, bothSeg[0], bothSeg[1]) + energy(musicOnly.outR, bothSeg[1], bothSeg[1]);

/* music-only section: input has music, output must be ~silent */
const inMusicSeg = energy(sig.mixL, musicSeg[0] - D, musicSeg[1] - D) + energy(sig.mixR, musicSeg[0] - D, musicSeg[1] - D);
const outMusicSeg = energy(mixR.outL, musicSeg[0], musicSeg[1]) + energy(mixR.outR, musicSeg[0], musicSeg[1]);
const gateDb = dB(outMusicSeg / inMusicSeg);
check("music-only parts are silenced", gateDb < -20, "attenuation " + round(gateDb, 1) + " dB");

/* voice retention in the singing section */
const retention = dB(outBoth / outVoiceRef);
check("voice survives the mask", retention > -14, "voice level " + round(retention, 1) + " dB");

/* bass / hats suppression in the singing section (voice has no energy there) */
const bassIn = bandEnergy(sig.musicL, SR, bothSeg[0] - D, bothSeg[1] - D, 60, 120);
const bassOut = bandEnergy(mixR.outL, SR, bothSeg[0], bothSeg[1], 60, 120);
const bassDb = dB(bassOut / Math.max(bassIn, 1e-20));
check("bass / kick removed", bassDb < -18, "bass " + round(bassDb, 1) + " dB");

const hatIn = bandEnergy(sig.musicL, SR, bothSeg[0] - D, bothSeg[1] - D, 6000, 9500);
const hatOut = bandEnergy(mixR.outL, SR, bothSeg[0], bothSeg[1], 6000, 9500);
const hatDb = dB(hatOut / Math.max(hatIn, 1e-20));
check("cymbals / hats removed", hatDb < -12, "hats " + round(hatDb, 1) + " dB");

/* speech-band SNR improvement (voice vs music energy around the vocal band) */
const spIn = bandEnergy(sig.voiceL, SR, bothSeg[0] - D, bothSeg[1] - D, 400, 3000);
const spInMusic = bandEnergy(sig.musicL, SR, bothSeg[0] - D, bothSeg[1] - D, 400, 3000);
const spOut = bandEnergy(mixR.outL, SR, bothSeg[0], bothSeg[1], 400, 3000);
const spOutMusic = bandEnergy(musicOnly.outL, SR, bothSeg[0], bothSeg[1], 400, 3000);
const snrIn = dB(spIn / Math.max(spInMusic, 1e-20)), snrOut = dB(spOut / Math.max(spOutMusic, 1e-20));
check("voice/music ratio improves", snrOut - snrIn > 6, "in " + round(snrIn, 1) + " dB → out " + round(snrOut, 1) + " dB (+" + round(snrOut - snrIn, 1) + ")");

/* Max must discard side energy even while voice opens the same bins. */
for (const sr of [44100, 48000]) {
  const { Processor: P } = loadEngine(sr);
  const fixture = makeSignals(sr, 10);
  const result = run(P, { L: fixture.mixL, R: fixture.mixR, sr, n: fixture.n },
    { strength: "max" });
  let side = 0;
  for (let i = 0; i < result.outL.length; i++) side += (result.outL[i] - result.outR[i]) ** 2;
  const sideDb = dB(side / Math.max(energy(result.outL, 0, result.outL.length) * result.outL.length, 1e-20));
  check("max removes side-channel leakage at " + sr, sideDb < -100, round(sideDb, 1) + " dB");
  const vocal = run(P, { L: fixture.voiceL, R: fixture.voiceR, sr, n: fixture.n },
    { strength: "max" });
  const from = 5 * sr, to = 9 * sr;
  const retention = dB(energy(vocal.outL, from + D, to + D) /
    Math.max(energy(fixture.voiceL, from, to), 1e-20));
  check("max retains centred synthetic vocal at " + sr, retention > -16, round(retention, 1) + " dB");
}

/* mono material must still work (spatial cue disabled) */
{
  const n = SR * 8;
  const mL = new Float32Array(n), mR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = (t > 3 ? 0.35 * Math.sin(2 * Math.PI * 180 * t) + 0.18 * Math.sin(2 * Math.PI * 720 * t) : 0);
    const m = 0.4 * Math.sin(2 * Math.PI * 90 * t);
    mL[i] = mR[i] = v + m;
  }
  const r = run(Processor, { L: mL, R: mR, sr: SR, n }, { strength: "strong" });
  const inSilent = energy(mL, D, D + SR * 2), outSilent = energy(r.outL, D + SR * 2, D + SR * 3 - 1024);
  const cut = dB(outSilent / Math.max(inSilent, 1e-20));
  check("mono: music-only intro silenced", cut < -15, round(cut, 1) + " dB");
  const inV = energy(mL, D + SR * 4, D + SR * 7), outV = energy(r.outL, D + SR * 4, D + SR * 7);
  check("mono: voice still audible", dB(outV / Math.max(inV, 1e-20)) > -16, round(dB(outV / Math.max(inV, 1e-20)), 1) + " dB");
}
console.log("");

/* ---------------- 5. realtime head-room + stats + capture ---------------- */
{
  const BLOCK = 128;
  const n = SR * 10;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.2 * Math.sin(i * 0.01); R[i] = 0.2 * Math.sin(i * 0.011); }
  const inL = new Float32Array(BLOCK), inR = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);

  /* one pass over `seconds` of audio through a fresh processor */
  function pass(seconds, capture) {
    const proc = new Processor();
    proc.port.onmessage({ data: { t: "params", strength: "balanced", capture: capture } });
    const total = Math.min(n, SR * seconds);
    const t0 = process.hrtime.bigint();
    for (let off = 0; off < total; off += BLOCK) {
      for (let i = 0; i < BLOCK; i++) { inL[i] = L[off + i]; inR[i] = R[off + i]; }
      proc.process([[inL, inR]], [[oL, oR]]);
    }
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, seconds: total / SR };
  }

  pass(2, false);                       /* warm the JIT — never measured */
  messages.length = 0;                  /* only the timed passes count below */
  /* best of three: the metric should describe the DSP, not this machine's
     momentary load (the sandbox is shared, so a single pass is noisy) */
  let best = pass(7, true);
  for (let run = 0; run < 2; run++) {
    const next = pass(7, true);
    if (next.ms < best.ms) best = next;
  }
  const rt = best.seconds * 1000 / best.ms;
  check("runs far faster than realtime", rt > 8, round(rt, 1) + "× realtime");

  const pcm = messages.filter(m => m.t === "pcm");
  const samples = pcm.reduce((s, m) => s + m.samples, 0);
  check("capture streams 16-bit PCM", samples > SR * 5, samples + " samples captured");
  const stats = messages.filter(m => m.t === "stats");
  check("live metrics are reported", stats.length > 5, stats.length + " stat messages");
}

console.log("");
if (failures) {
  console.log(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("all AI engine checks passed");
