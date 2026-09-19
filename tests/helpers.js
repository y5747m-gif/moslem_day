/* Shared jsdom harness for the VocalPure headless tests.
 *
 * jsdom has no Web Audio, canvas or IndexedDB, so this file installs small
 * but behaviourally faithful stand-ins before the page scripts run:
 *   - AudioContext / OfflineAudioContext with the node types the engine
 *     uses (gain, biquad, compressor, splitter/merger, analyser, source)
 *   - decodeAudioData() that returns a synthetic stereo "song" (a centred
 *     voice-like tone plus wide side content) so the FFT analyzer has
 *     something realistic to measure
 *   - matchMedia, URL.createObjectURL, scrollTo
 * Any uncaught page error is collected and reported by the test runner.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole, ResourceLoader } = require("jsdom");

/* Serves http://localhost/<repo path> straight from the working tree so the
 * page's <link>/<script> tags resolve without a web server. */
class RepoLoader extends ResourceLoader {
  fetch(url, options) {
    const u = new URL(url);
    if (u.hostname === "localhost") {
      const file = path.join(ROOT, decodeURIComponent(u.pathname));
      return new Promise((resolve, reject) => {
        fs.readFile(file, (err, data) => (err ? reject(err) : resolve(data)));
      });
    }
    return super.fetch(url, options);
  }
}

const ROOT = path.resolve(__dirname, "..");

function synthBuffer(sr, nch, len) {
  const chans = [];
  for (let c = 0; c < nch; c++) chans.push(new Float32Array(len));
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    // "voice": harmonic tone in the centre (identical in both channels)
    const voice = 0.35 * Math.sin(2 * Math.PI * 220 * t) +
      0.2 * Math.sin(2 * Math.PI * 440 * t) +
      0.1 * Math.sin(2 * Math.PI * 880 * t);
    // "instruments": bass in the centre, wide (anti-phase) high content
    const bass = 0.25 * Math.sin(2 * Math.PI * 60 * t);
    const wide = 0.15 * Math.sin(2 * Math.PI * 5200 * t) + 0.08 * Math.sin(2 * Math.PI * 3100 * t + 1);
    chans[0][i] = voice + bass + wide;
    if (nch > 1) chans[1][i] = voice + bass - wide;
  }
  return {
    sampleRate: sr,
    numberOfChannels: nch,
    length: len,
    duration: len / sr,
    getChannelData(c) { return chans[c]; }
  };
}

function installAudioMocks(win, log) {
  class Param {
    constructor(v) { this.value = v; this.defaultValue = v; }
    setTargetAtTime(v) { this.value = v; return this; }
    setValueAtTime(v) { this.value = v; return this; }
    linearRampToValueAtTime(v) { this.value = v; return this; }
    exponentialRampToValueAtTime(v) { this.value = v; return this; }
    cancelScheduledValues() { return this; }
  }
  class Node {
    constructor(ctx) { this.context = ctx; this.numberOfInputs = 1; this.numberOfOutputs = 1; this._out = []; }
    connect(n) { this._out.push(n); return n; }
    disconnect() { this._out = []; }
  }
  class Gain extends Node { constructor(c) { super(c); this.gain = new Param(1); } }
  class Biquad extends Node {
    constructor(c) { super(c); this.type = "lowpass"; this.frequency = new Param(350); this.Q = new Param(1); this.gain = new Param(0); this.detune = new Param(0); }
  }
  class Comp extends Node {
    constructor(c) { super(c); this.threshold = new Param(-24); this.knee = new Param(30); this.ratio = new Param(12); this.attack = new Param(0.003); this.release = new Param(0.25); this.reduction = 0; }
  }
  class Analyser extends Node {
    constructor(c) { super(c); this.fftSize = 2048; this.smoothingTimeConstant = 0.8; this.minDecibels = -100; this.maxDecibels = -30; }
    get frequencyBinCount() { return this.fftSize / 2; }
    getByteFrequencyData(a) { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 90) % 255; }
    getByteTimeDomainData(a) { a.fill(128); }
  }
  class Splitter extends Node {}
  class Merger extends Node {}
  class BufferSource extends Node {
    constructor(c) { super(c); this.buffer = null; this.playbackRate = new Param(1); this.loop = false; this.onended = null; this.started = false; this.stopped = false; }
    start(when, offset) { this.started = true; this.offset = offset || 0; this.context.sources.push(this); log.sourceStarts++; }
    stop() { this.stopped = true; }
  }
  class BaseCtx {
    constructor() {
      this._t0 = Date.now();
      this.sampleRate = 44100;
      this.state = "running";
      this.destination = new Node(this);
      this.sources = [];
    }
    get currentTime() { return (Date.now() - this._t0) / 1000; }
    createGain() { return new Gain(this); }
    createBiquadFilter() { return new Biquad(this); }
    createDynamicsCompressor() { return new Comp(this); }
    createAnalyser() { return new Analyser(this); }
    createChannelSplitter() { return new Splitter(this); }
    createChannelMerger() { return new Merger(this); }
    createBufferSource() { return new BufferSource(this); }
    createBuffer(nch, len, sr) { return synthBuffer(sr, nch, len); }
    decodeAudioData(ab, ok, fail) {
      log.decodes++;
      const bytes = ab && ab.byteLength !== undefined ? ab.byteLength : 0;
      if (bytes < 16) {
        const err = new Error("EncodingError: corrupt");
        if (fail) { setTimeout(() => fail(err), 0); return undefined; }
        return Promise.reject(err);
      }
      const buf = synthBuffer(44100, 2, 44100 * 3);
      const p = Promise.resolve(buf);
      if (ok) p.then(ok);
      return p;
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    suspend() { this.state = "suspended"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  class AudioContext extends BaseCtx {
    constructor() { super(); log.contexts++; }
  }
  class OfflineAudioContext extends BaseCtx {
    constructor(nch, len, sr) { super(); this.numberOfChannels = nch; this.length = len; this.sampleRate = sr; log.offline++; }
    startRendering() { return Promise.resolve(synthBuffer(this.sampleRate, this.numberOfChannels, Math.min(this.length, this.sampleRate))); }
  }
  win.AudioContext = AudioContext;
  win.OfflineAudioContext = OfflineAudioContext;
}

/**
 * Load an HTML file from the repo into jsdom with scripts enabled.
 * @param {string} relHtml  path relative to repo root, e.g. "app/index.html"
 * @param {object} [opts]   { url, beforeParse(win) }
 */
function loadPage(relHtml, opts) {
  opts = opts || {};
  const file = path.join(ROOT, relHtml);
  const html = fs.readFileSync(file, "utf8");
  const errors = [];
  const ignored = [];
  const log = { decodes: 0, contexts: 0, offline: 0, sourceStarts: 0, objectUrls: 0 };

  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    const msg = String(e && e.message || e);
    if (e && e.type === "XMLHttpRequest") { ignored.push("xhr: " + msg); return; } // offline app-info.json probe
    if (/Not implemented/i.test(msg) || /ECONNREFUSED|Could not load|network error/i.test(msg)) { ignored.push(msg); return; }
    errors.push(msg + (e && e.detail && e.detail.stack ? "\n" + e.detail.stack : ""));
  });
  vc.on("error", (m) => { errors.push("console.error: " + String(m)); });
  vc.on("warn", () => {});
  vc.on("log", () => {});
  vc.on("info", () => {});

  const dom = new JSDOM(html, {
    url: opts.url || ("http://localhost/" + relHtml.replace(/\\/g, "/")),
    runScripts: "dangerously",
    resources: new RepoLoader(),
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      installAudioMocks(win, log);
      const mq = { matches: false, media: "(prefers-color-scheme: dark)", listeners: [],
        addEventListener(t, f) { this.listeners.push(f); }, removeEventListener() {},
        addListener(f) { this.listeners.push(f); }, removeListener() {},
        fire() { const self = this; this.listeners.forEach((f) => f({ matches: self.matches })); } };
      win.__darkMq = mq;
      win.matchMedia = () => mq;
      win.URL.createObjectURL = () => { log.objectUrls++; return "blob:mock/" + log.objectUrls; };
      win.URL.revokeObjectURL = () => {};
      win.Element.prototype.scrollTo = function () {};
      win.Element.prototype.scrollIntoView = function () {};
      win.HTMLElement.prototype.setPointerCapture = function () {};
      win.HTMLElement.prototype.releasePointerCapture = function () {};
      win.fetch = () => Promise.reject(new Error("offline"));
      if (opts.beforeParse) opts.beforeParse(win);
    }
  });
  return { dom, window: dom.window, document: dom.window.document, errors, ignored, log };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Poll until fn() is truthy (max `timeout` ms). */
async function waitFor(fn, timeout, what) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > (timeout || 4000)) throw new Error("timeout waiting for " + (what || fn.toString().slice(0, 80)));
    await sleep(25);
  }
}

function visible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  for (let p = el; p; p = p.parentElement) {
    if (p.hidden) return false;
    if (p.classList && (p.classList.contains("is-hidden"))) return false;
  }
  return true;
}

function click(el) {
  if (!el) throw new Error("click on missing element");
  const win = el.ownerDocument.defaultView;
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
}

function input(el, value) {
  const win = el.ownerDocument.defaultView;
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}

function makeAudioFile(win, name, sizeKb) {
  const bytes = new Uint8Array((sizeKb || 4) * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
  return new win.File([bytes], name, { type: "audio/mpeg" });
}

function setFiles(inputEl, files) {
  Object.defineProperty(inputEl, "files", { configurable: true, get: () => files });
  const win = inputEl.ownerDocument.defaultView;
  inputEl.dispatchEvent(new win.Event("change", { bubbles: true }));
}

/* tiny test runner */
function makeRunner(title) {
  const results = [];
  let current = null;
  const api = {
    section(name) { current = name; process.stdout.write("\n" + name + "\n"); },
    check(name, cond, detail) {
      const ok = !!cond;
      results.push({ section: current, name, ok, detail });
      process.stdout.write("  " + (ok ? "✓" : "✗") + " " + name + (ok || detail === undefined ? "" : "  → " + String(detail)) + "\n");
      return ok;
    },
    eq(name, a, b) { return api.check(name, a === b, "got " + JSON.stringify(a) + ", expected " + JSON.stringify(b)); },
    finish(extraFailures) {
      const failed = results.filter((r) => !r.ok);
      const extra = extraFailures || [];
      process.stdout.write("\n" + title + ": " + (results.length - failed.length) + "/" + results.length + " checks passed" +
        (extra.length ? ", " + extra.length + " page error(s)" : "") + "\n");
      extra.forEach((e) => process.stdout.write("  page error: " + e + "\n"));
      if (failed.length || extra.length) process.exit(1);
    }
  };
  return api;
}

module.exports = { ROOT, loadPage, sleep, waitFor, visible, click, input, makeAudioFile, setFiles, makeRunner };
