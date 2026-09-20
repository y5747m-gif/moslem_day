#!/usr/bin/env node
"use strict";
/* Release-blocking regression probe, NOT a source-separation benchmark.
 * Original, procedurally generated instrumental fixture (CC0): a centred
 * additive synthesizer. No recordings, downloads, model mocks, or network.
 * Fixed-size render buffers; the actual shipping AudioWorklet runs in a VM.
 * Passing this necessary condition would NOT establish vocal intelligibility,
 * mixed-stem leakage, real-song quality, or Android runtime compatibility.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app/vp-ai-engine.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app/app.js"), "utf8");
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
}
// Narrow regression guards for known unsafe paths, not graph verification.
check("no known pre-initialization original connection",
  !/mediaSrc\.connect\(voiceGain\)/.test(app));
check("no legacy filter fallback", !/useFilterEngine\s*\(/.test(app));
check("no worklet bypass parameter", !/typeof d\.bypass/.test(source));

function instrument(t) {
  const f = 220;
  const phase = 2 * Math.PI * f * t + 0.8 * Math.sin(2 * Math.PI * 4 * t);
  // Bowed/reed-like synthetic timbre in the same frequency range as singing.
  const envelope = 0.65 + 0.35 * Math.sin(2 * Math.PI * 2 * t);
  let y = 0;
  for (let h = 1; h <= 16; h++) y += Math.sin(h * phase) / (h * h);
  return 0.25 * envelope * y;
}
for (const sr of [44100, 48000]) {
  for (const channels of [1, 2]) {
    let Processor;
    const context = vm.createContext({
      sampleRate: sr, currentTime: 0,
      AudioWorkletProcessor: class {
        constructor() { this.port = { postMessage() {}, onmessage: null }; }
      },
      registerProcessor(name, cls) { if (name === "vp-ai-voice") Processor = cls; }
    });
    vm.runInContext(source + "\nVPAIEngineFactory();", context);
    const processor = new Processor();
    processor.port.onmessage({ data: { t: "params", strength: "max", gateOn: true } });
    const block = 128, delay = 1023;
    const input = Array.from({ length: channels }, () => new Float32Array(block));
    const output = [new Float32Array(block), new Float32Array(block)];
    let inEnergy = 0, outEnergy = 0, samples = 0;
    const start = sr * 2 + delay, end = sr * 8 + delay;
    for (let off = 0; off < end; off += block) {
      for (let i = 0; i < block; i++) {
        for (let c = 0; c < channels; c++) input[c][i] = instrument((off + i) / sr);
      }
      processor.process([input], [output]);
      for (let i = 0; i < block; i++) {
        const n = off + i;
        if (n < start || n >= end) continue;
        const ref = instrument((n - delay) / sr);
        inEnergy += ref * ref;
        // Measure both output channels; a leak in either must count.
        outEnergy += (output[0][i] ** 2 + output[1][i] ** 2) / 2;
        samples++;
      }
    }
    const finite = Number.isFinite(outEnergy) && inEnergy > 0 && samples > 0;
    const attenuation = outEnergy === 0 ? -Infinity : 10 * Math.log10(outEnergy / inEnergy);
    check(`${sr} Hz / ${channels === 1 ? "mono" : "stereo"}: instrumental leakage <= -50 dB`,
      finite && attenuation <= -50,
      `${attenuation.toFixed(2)} dB (target <= -60 dB), ${samples} measured frames`);
  }
}
console.log("NOT VALIDATED: real recordings, vocal retention, mixed-stem leakage, long-file RSS, native inference, playback/export integration.");
console.log(`${failed} release-blocking regression(s). This probe cannot certify a release.`);
process.exitCode = failed ? 1 : 0;
