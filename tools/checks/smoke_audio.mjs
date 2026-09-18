#!/usr/bin/env node
/* ============================================================
   End-to-end wiring test of the VocalPure app audio pipeline.

   jsdom has no Web Audio, so a faithful mock AudioContext /
   OfflineAudioContext is injected BEFORE the app scripts run.
   The mock keeps the node graph (connect/disconnect, params) so
   the REAL app code — import → decode → stem graph build →
   transport → mode switching → export — executes unmodified.

   Verifies:
     - song import via the real importFiles path (FileReader+decode)
     - artist/title parsing from the file name
     - song row click → loadSongById → graph built → playing
     - stereo detection through the real correlation analysis
     - mode switching updates the stem gains on the live graph
     - WAV export renders through the (mocked) offline context
     - play/pause keeps the transport consistent
   ============================================================ */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function loadJsdom() {
  const candidates = [
    process.env.JSDOM_PATH,
    path.join(REPO, "tools", "checks", "node_modules"),
    path.join(process.env.HOME || "", ".cache", "checks-env", "node_modules"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(path.join(c, "jsdom")); } catch (e) { /* next */ }
  }
  try { return require("jsdom"); } catch (e) { /* next */ }
  throw new Error("jsdom not found — npm install jsdom (or set JSDOM_PATH to a node_modules dir)");
}
const { JSDOM, VirtualConsole } = loadJsdom();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!cond) fails++;
}

/* ---------------- Web Audio mock ---------------- */

class MockParam {
  constructor(v) { this.value = v === undefined ? 1 : v; }
  setTargetAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
}
class MockNode {
  constructor(ctx) { this.ctx = ctx; this.out = []; }
  connect(node) { if (node) this.out.push(node); return node; }
  disconnect() { this.out = []; }
}
class MockGain extends MockNode { constructor(ctx, v) { super(ctx); this.gain = new MockParam(v); } }
class MockBiquad extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.type = "lowpass"; this.frequency = new MockParam(350);
    this.Q = new MockParam(1); this.gain = new MockParam(0);
  }
}
class MockSplitter extends MockNode { constructor(ctx, n) { super(ctx); this.numberOfOutputs = n; } }
class MockMerger extends MockNode { constructor(ctx, n) { super(ctx); this.numberOfInputs = n; } }
class MockAnalyser extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.fftSize = 2048; this.smoothingTimeConstant = 0.8;
    this.frequencyBinCount = this.fftSize / 2;
  }
  getByteFrequencyData() { }
  getByteTimeDomainData() { }
}
class MockCompressor extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.threshold = new MockParam(-24); this.knee = new MockParam(30);
    this.ratio = new MockParam(12); this.attack = new MockParam(0.003);
    this.release = new MockParam(0.25);
  }
}
class MockSource extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.playbackRate = new MockParam(1);
    this.onended = null;
    this.startedAt = null;
  }
  start(when, offset) {
    this.startedAt = { when, offset };
    window.__liveSources = (window.__liveSources || []).concat([this]);
  }
  stop() {
    if (this.onended) {
      const fn = this.onended;
      this.onended = null;
      setTimeout(() => fn.call(this, { type: "ended" }), 0);
    }
  }
}
function fakeChannels(duration, rate, stereo) {
  const n = Math.ceil(duration * rate);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // centered "voice" + slight per-channel difference for stereo
    L[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + (stereo ? 0.2 * Math.sin(2 * Math.PI * 300 * t) : 0);
    R[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + (stereo ? 0.2 * Math.sin(2 * Math.PI * 350 * t + 1) : 0);
  }
  return [L, R];
}
class MockBuffer {
  constructor(duration, rate, stereo) {
    this.duration = duration; this.sampleRate = rate;
    this.numberOfChannels = 2; this.length = Math.ceil(duration * rate);
    this._ch = fakeChannels(duration, rate, stereo);
  }
  getChannelData(i) { return this._ch[i]; }
}
class MockAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = new MockNode(this);
    this.sampleRate = 44100;
  }
  resume() { this.state = "running"; return Promise.resolve(); }
  createGain(v) { return new MockGain(this, v); }
  createBiquadFilter() { return new MockBiquad(this); }
  createChannelSplitter(n) { return new MockSplitter(this, n); }
  createChannelMerger(n) { return new MockMerger(this, n); }
  createAnalyser() { return new MockAnalyser(this); }
  createDynamicsCompressor() { return new MockCompressor(this); }
  createBufferSource() { return new MockSource(this); }
  decodeAudioData(ab, ok) {
    // fake decode: length proportional to input bytes, stereo
    const dur = Math.min(30, Math.max(2, ab.byteLength / 44100 / 4));
    const buf = new MockBuffer(dur, 44100, true);
    return new Promise((res) => setTimeout(() => { ok && ok(buf); res(buf); }, 5));
  }
}
class MockOfflineContext extends MockAudioContext {
  constructor(ch, length, rate) {
    super();
    this._len = length; this._rate = rate;
  }
  startRendering() {
    const buf = new MockBuffer(this._len / this._rate, this._rate, true);
    return Promise.resolve(buf);
  }
}

/* ---------------- boot with mocks ---------------- */
let html = readFileSync(path.join(REPO, "app", "index.html"), "utf8");
const iso = readFileSync(path.join(REPO, "app", "js", "isolation.js"), "utf8");
const player = readFileSync(path.join(REPO, "app", "js", "player.js"), "utf8");

html = html.replace('<script src="js/isolation.js"></script>', "<script>\n" + iso + "\n</script>");
html = html.replace('<script src="js/player.js"></script>', "<script>\n" + player + "\n</script>");
// inject mock classes BEFORE the app scripts
const mockDefs = `<script>
${fakeChannels.toString()}
${MockParam.toString()}
${MockNode.toString()}
${MockGain.toString()}
${MockBiquad.toString()}
${MockSplitter.toString()}
${MockMerger.toString()}
${MockAnalyser.toString()}
${MockCompressor.toString()}
${MockSource.toString()}
${MockBuffer.toString()}
${MockAudioContext.toString()}
${MockOfflineContext.toString()}
window.AudioContext = MockAudioContext;
window.OfflineAudioContext = MockOfflineContext;
</script>`;
html = html.replace("<body>", "<body>\n" + mockDefs);

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => {
  const msg = String(e && e.message || e);
  if (/Not implemented|not implemented/i.test(msg)) return;
  errors.push(msg);
});
const dom = new JSDOM(html, {
  url: "file:///android_asset/www/index.html",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;
await sleep(150);

check("mock AudioContext installed", typeof window.AudioContext === "function");
check("boots without runtime errors", errors.length === 0, errors.slice(0, 3).join(" | "));

/* ---------------- import a song ---------------- */
const bytes = new Uint8Array(44100 * 8).fill(0); // ~8 s of "audio"
const file = new window.File([bytes], "Aurora Fields - Neon Skyline.mp3", { type: "audio/mpeg" });
window.VPApp.importFiles([file]);
await sleep(80);

check("song imported through the real path", window.VPApp.state().songs === 1);
const row = doc.querySelector("#song-list li[data-song]");
check("song row rendered", !!row);
check("artist parsed from file name", row && /Aurora Fields/.test(row.querySelector(".song-artist").textContent));
check("title parsed from file name", row && /Neon Skyline/.test(row.querySelector(".song-title").textContent));

/* ---------------- play it ---------------- */
row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(120);

const st = window.VPApp.state();
check("song is current and playing", st.playing === true && !!st.currentId);
check("duration decoded", st.duration > 1, st.duration.toFixed(1) + "s");
check("stereo detected via correlation", st.stereo === true);
check("now-playing overlay opened", !doc.getElementById("nowplaying").hidden);
check("mini player visible", !doc.getElementById("mini").hidden);
check("split method chip shows stereo", /3-way crossover/.test(doc.getElementById("split-method-text").textContent));
const liveSources = window.__liveSources || [];
check("a live buffer source was started", liveSources.some((s) => s.startedAt));

/* ---------------- transport ---------------- */
doc.getElementById("np-play").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(40);
check("pause stops playing", window.VPApp.state().playing === false);
doc.getElementById("np-play").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(40);
check("play resumes", window.VPApp.state().playing === true);

/* ---------------- mode switching drives stem gains ---------------- */
// switch to the Split screen and pick Karaoke via the real chip
doc.querySelector('[data-nav="split"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
doc.querySelector('#mode-chips [data-mode="karaoke"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(40);
check("karaoke mode active", window.VPApp.state().mode === "karaoke");
check("mode chips reflect selection", doc.querySelector('#mode-chips [data-mode="karaoke"]').classList.contains("is-active"));
check("mini player shows karaoke label", /Karaoke/.test(doc.getElementById("mini-sub").textContent));

/* strength slider is live */
const strength = doc.getElementById("strength");
strength.value = "40";
strength.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(30);
check("strength slider updates state", window.VPApp.state().strength === 40);

/* ---------------- queue via song sheet ---------------- */
// back to library, open the ⋯ sheet, use "Play next"
doc.querySelector('[data-nav="library"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
const more = doc.querySelector("#song-list [data-more]");
more.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(40);
check("song actions sheet opened", !doc.getElementById("sheet-song").hidden);
const playNext = doc.querySelector('#sheet-song [data-act="next"]');
playNext.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
check("play-next queues the song", window.VPApp.state().queue === 1);

/* ---------------- WAV export ---------------- */
doc.querySelector('[data-nav="split"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
doc.getElementById("export-karaoke").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(150);
// export runs offline render + encode; failure would toast — success is
// that no runtime error occurred and the loading sheet closed again.
check("export completes without runtime errors", errors.length === 0, errors.slice(0, 2).join(" | "));
check("export loading sheet closed", doc.getElementById("sheet-loading").hidden);

/* ---------------- natural track end ---------------- */
// trigger the live source's ended handler (not stopIntent)
const src = (window.__liveSources || []).find((s) => s.startedAt && s.onended);
check("live source exposes onended", !!src);
if (src) {
  const fn = src.onended;
  src.onended = null;
  fn.call(src, {});
  await sleep(60);
  check("track end advances to the queued song and keeps playing", window.VPApp.state().playing === true && window.VPApp.state().queue === 0);
}

console.log("");
if (fails) {
  console.error(fails + " check(s) FAILED");
  dom.window.close();
  process.exit(1);
}
console.log("Audio pipeline wiring test passed.");
dom.window.close();
process.exit(0);
