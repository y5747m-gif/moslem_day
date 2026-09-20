#!/usr/bin/env node
/* ============================================================================
   VocalPure — functional smoke test  ·  tools/smoke_app.js
   ----------------------------------------------------------------------------
   Loads the real app (app/index.html + app/app.js + app/vp-ai-engine.js) into
   jsdom with mocked Web Audio / IndexedDB / Android bridge, boots it, then
   drives the UI the way a listener would: device scan, playback, AI controls,
   search, settings, import, capture export, library clearing.

   It also runs a scope analysis over every app JS file, which catches the
   classic partial-rewrite bug (a symbol used but never declared).

   Usage:  npm --prefix tools install     (first time)
           node tools/smoke_app.js
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const TOOLS = __dirname;
const ROOT = path.join(TOOLS, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* dependencies live in tools/node_modules so the repo itself stays clean */
function loadDep(name) {
  const local = path.join(TOOLS, "node_modules", name);
  if (fs.existsSync(local)) return require(local);
  try { return require(name); } catch (e) { /* fall through */ }
  console.log("Missing test dependency “" + name + "”. Run:  npm --prefix tools install");
  process.exit(2);
}
const { JSDOM } = loadDep("jsdom");
const FakeIndexedDB = loadDep("fake-indexeddb");
const acorn = loadDep("acorn");
const walk = loadDep("acorn-walk");

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log((ok ? "  \u2713 " : "  \u2717 ") + name + (detail ? "   [" + detail + "]" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ scope */
console.log("\nScope analysis (undeclared symbols)");
const GLOBALS = new Set(["window", "document", "console", "Math", "JSON", "Object", "Array", "String", "Number",
  "Boolean", "Date", "RegExp", "Error", "TypeError", "Promise", "Map", "Set", "WeakMap", "Symbol", "Proxy", "Reflect",
  "isFinite", "isNaN", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance", "localStorage",
  "sessionStorage", "indexedDB", "IDBKeyRange", "Blob", "File", "FileReader", "URL", "Uint8Array", "Int8Array",
  "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "ArrayBuffer", "DataView",
  "TextEncoder", "TextDecoder", "btoa", "atob", "fetch", "XMLHttpRequest", "AudioContext", "webkitAudioContext",
  "AudioWorkletNode", "OfflineAudioContext", "navigator", "location", "history", "screen", "self", "globalThis",
  "undefined", "NaN", "Infinity", "arguments", "eval", "Node", "Event", "CustomEvent", "Audio", "queueMicrotask",
  "Intl", "BigInt", "crypto", "AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentTime", "process",
  "prompt", "confirm", "alert", "escape", "unescape", "requestIdleCallback", "matchMedia", "CSS",
  "IntersectionObserver", "BroadcastChannel", "ResizeObserver", "MediaQueryList", "getComputedStyle", "AudioWorklet", "Image"]);

function scopeProblems(file) {
  const src = read(file);
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: "script" }); }
  catch (e) { return ["parse error: " + e.message]; }
  const declared = new Set();
  function add(pat) {
    if (!pat) return;
    switch (pat.type) {
      case "Identifier": declared.add(pat.name); break;
      case "ObjectPattern": pat.properties.forEach((p) => add(p.value || p.argument)); break;
      case "ArrayPattern": pat.elements.forEach(add); break;
      case "AssignmentPattern": add(pat.left); break;
      case "RestElement": add(pat.argument); break;
      default: break;
    }
  }
  walk.full(ast, (node) => {
    if (node.type === "VariableDeclarator") add(node.id);
    if (node.type === "ClassDeclaration" && node.id) declared.add(node.id.name);
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      node.params.forEach(add);
      if (node.id) declared.add(node.id.name);
    }
    if (node.type === "CatchClause") add(node.param);
  });
  const bad = [];
  walk.ancestor(ast, {
    Identifier(node, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
      if (parent.type === "Property" && parent.key === node && !parent.computed) return;
      if (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) return;
      if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return;
      if (parent.type === "VariableDeclarator" && parent.id === node) return;
      if (parent.type === "FunctionDeclaration" && parent.id === node) return;
      if (parent.type === "FunctionExpression" && parent.id === node) return;
      if (parent.type === "ClassDeclaration" && parent.id === node) return;
      const params = parent.params || (parent.param ? [parent.param] : []);
      if (params.indexOf(node) >= 0) return;
      if (declared.has(node.name) || GLOBALS.has(node.name)) return;
      const line = src.slice(0, node.start).split("\n").length;
      if (!bad.some((s) => s.indexOf(node.name + " ") === 0)) bad.push(node.name + " (line " + line + ")");
    }
  });
  return bad;
}
for (const file of ["app/app.js", "app/vp-ai-engine.js", "app/vp-cover.js", "js/app.js", "js/background.js"]) {
  const problems = scopeProblems(file);
  check(file + " has no undeclared symbols", problems.length === 0, problems.join(", "));
}

/* ------------------------------------------------------------------- dom */
const APP = path.join(ROOT, "app");
const html = read("app/index.html").replace(/<script[^>]*><\/script>/g, "");
const appJs = read("app/app.js");
const engineJs = read("app/vp-ai-engine.js");
const coverJs = read("app/vp-cover.js");

function param(v) {
  return { value: v, setValueAtTime() { return this; }, setTargetAtTime() { return this; },
    linearRampToValueAtTime() { return this; }, cancelScheduledValues() { return this; } };
}
function mnode(extra) {
  const n = Object.assign({ connect(t) { n._to = t; return t; }, disconnect() {}, _to: null }, extra || {});
  return n;
}

/**
 * Boots the real app inside jsdom with mocked Web Audio, IndexedDB and the
 * Android bridge.  opts.worklet === false simulates an old WebView without
 * AudioWorklet so the filter fallback is exercised too.
 */
function boot(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, { url: "https://vocalpure.local/app/index.html", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window;
  const errors = [];
  win.addEventListener("error", (e) => errors.push("window error: " + e.message));
  win.console.error = (...a) => errors.push("console.error: " + a.join(" "));

  const workletParams = [];
  class MockWorkletNode {
    constructor(ctx, name, workletOpts) {
      this.name = name; this.options = workletOpts;
      this.port = { postMessage: (m) => workletParams.push(m), onmessage: null };
      MockWorkletNode.instances.push(this);
    }
    connect() {} disconnect() {}
  }
  MockWorkletNode.instances = [];

  class MockCtx {
    constructor() {
      this.state = "running"; this.sampleRate = 48000; this.currentTime = 0; this.destination = mnode();
      if (opts.worklet !== false) this.audioWorklet = { addModule: () => Promise.resolve() };
      this._nodes = [];
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    _track(n) { this._nodes.push(n); return n; }
    createGain() { return this._track(mnode({ gain: param(1) })); }
    createBiquadFilter() { return this._track(mnode({ type: "peaking", frequency: param(1000), Q: param(1), gain: param(0) })); }
    createDynamicsCompressor() { return this._track(mnode({ threshold: param(-10), knee: param(12), ratio: param(5), attack: param(0.004), release: param(0.2) })); }
    createAnalyser() { return this._track(mnode({ fftSize: 256, smoothingTimeConstant: 0.8, frequencyBinCount: 128, getByteFrequencyData(a) { a.fill(90); } })); }
    createMediaElementSource() { return this._track(mnode()); }
    createBufferSource() { return this._track(mnode({ buffer: null, start() {}, stop() {} })); }
    createChannelMerger() { return this._track(mnode()); }
    decodeAudioData() {
      const n = 48000, ch = new Float32Array(n);
      for (let i = 0; i < n; i++) ch[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / 48000) + (i % 2 ? 0.05 : -0.05);
      return Promise.resolve({ sampleRate: 48000, duration: 1, length: n, numberOfChannels: 2, getChannelData: () => ch });
    }
  }

  win.AudioContext = MockCtx;
  if (opts.worklet !== false) win.AudioWorkletNode = MockWorkletNode;

  win.AudioNode = function () {};
  win.URL.createObjectURL = () => "blob:mock/" + Math.random().toString(36).slice(2);
  win.URL.revokeObjectURL = () => {};
  win.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: "2.11.0", changelog: ["AI voice engine", "large files"] }) });
  /* a fresh factory per boot so scenarios cannot see each other's songs */
  win.indexedDB = new FakeIndexedDB.IDBFactory();
  win.IDBKeyRange = FakeIndexedDB.IDBKeyRange;
  win.XMLHttpRequest = function () { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; };

  const mediaProto = win.HTMLMediaElement.prototype;
  /* like a real browser: assigning .src kicks off metadata loading */
  Object.defineProperty(mediaProto, "src", {
    get() { return this._src || ""; },
    set(v) {
      this._src = v;
      setTimeout(() => this.dispatchEvent(new win.Event("loadedmetadata")), 0);
    },
    configurable: true
  });
  Object.defineProperty(mediaProto, "duration", { get() { return this._d || 190; }, configurable: true });
  Object.defineProperty(mediaProto, "currentTime", { get() { return this._t || 0; }, set(v) { this._t = v; }, configurable: true });
  Object.defineProperty(mediaProto, "readyState", { get() { return 4; }, configurable: true });
  Object.defineProperty(mediaProto, "paused", { get() { return !this._playing; }, configurable: true });
  mediaProto.load = function () { const s = this; setTimeout(() => s.dispatchEvent(new win.Event("loadedmetadata")), 0); };
  mediaProto.play = function () { this._playing = true; this.dispatchEvent(new win.Event("play")); return Promise.resolve(); };
  mediaProto.pause = function () { if (!this._playing) return; this._playing = false; this.dispatchEvent(new win.Event("pause")); };
  win.HTMLCanvasElement.prototype.getContext = function () {
    const noop = () => {};
    const grad = () => ({ addColorStop: noop });
    return { clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, arc: noop,
      fill: noop, strokeRect: noop, save: noop, restore: noop, setTransform: noop, transform: noop, scale: noop,
      translate: noop, closePath: noop, roundRect: noop, fillText: noop, measureText: () => ({ width: 8 }),
      createLinearGradient: grad, createRadialGradient: grad,
      set fillStyle(v) {}, get fillStyle() { return ""; }, set strokeStyle(v) {}, get strokeStyle() { return ""; },
      set lineWidth(v) {}, get lineWidth() { return 1; }, set globalAlpha(v) {}, get globalAlpha() { return 1; } };
  };
  win.confirm = () => true;
  win.prompt = () => "Test playlist";

  const written = [];
  const mediaCalls = { meta: [], state: [], stop: 0, output: [], focusReq: 0, focusAb: 0, playing: [] };
  win.VocalPureAndroid = {
    appInfo: () => JSON.stringify({ versionName: "2.11.0", versionCode: 2110 }),
    hasStoragePermission: () => true,
    requestStoragePermission: () => {},
    openAppSettings: () => {},
    openUpdatePage: () => {},
    scanDeviceAudio: () => JSON.stringify([
      { path: "/storage/emulated/0/Music/a.mp3", title: "Big Song", artist: "Someone", duration: 3600, size: 90000000 },
      { path: "/storage/emulated/0/Music/b.m4a", title: "Second", artist: "Other", duration: 200, size: 3000000 }
    ]),
    readAudioBase64: () => "",
    writeFile: (name, b64, last) => { written.push({ name, len: b64.length, last }); return "ok:/music/" + name; },
    finishWav: () => "ok:/music/out.wav",
    /* pinned foreground notification + audio focus + output routing */
    setNowPlayingMeta: (t, a, art) => { mediaCalls.meta.push({ t, a, art: art ? art.length : 0 }); },
    setPlayState: (p, pos, dur, rate) => { mediaCalls.state.push({ p, pos, dur, rate }); },
    stopPlaybackNotification: () => { mediaCalls.stop++; },
    setAudioOutput: (m) => { mediaCalls.output.push(m); return m || "auto"; },
    getAudioState: () => JSON.stringify({ current: "auto", label: "Auto", btConnected: false, wiredConnected: false }),
    requestAudioFocus: () => { mediaCalls.focusReq++; },
    abandonAudioFocus: () => { mediaCalls.focusAb++; },
    setPlaying: (on) => { mediaCalls.playing.push(on); }
  };

  win.eval(coverJs);
  win.eval(engineJs);
  win.eval(appJs);
  return { win, errors, workletParams, written, MockWorkletNode, mediaCalls };
}

/* ------------------------------------------------ run the real app code */
const B = boot({ worklet: true });
const win = B.win;
const errors = B.errors;
const workletParams = B.workletParams;
const written = B.written;
const MockWorkletNode = B.MockWorkletNode;
const mediaCalls = B.mediaCalls;

/* ------------------------------ ui helpers ------------------------------ */
const $ = (id) => win.document.getElementById(id);
const click = (id) => { const el = $(id); if (!el) throw new Error("missing #" + id); el.dispatchEvent(new win.Event("click", { bubbles: true })); return el; };
const setInput = (el, value) => {
  if (!el) throw new Error("missing control");
  el.value = String(value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
};
const songRow = (list, text) => [...win.document.querySelectorAll("#" + list + " .song-row")]
  .find((r) => (text ? new RegExp(text, "i").test(r.textContent) : true));
function file(name, size, type) {
  const f = new win.File([new Uint8Array(1024)], name, { type: type || "audio/mpeg" });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

(async () => {
  await sleep(700);                      /* launch → permission → device scan */

  console.log("\nBoot");
  check("no runtime errors on launch", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("version shown from the Android bridge", /2\.11\.0/.test($("set-version").textContent), $("set-version").textContent);
  check("changelog rendered from app-info.json", $("set-changelog").children.length === 2);
  check("restored/added songs appear in the library", /2/.test($("set-song-count").textContent), $("set-song-count").textContent);

  console.log("\nPlayback (streamed, never decoded)");
  check("device scan listed a row per song", win.document.querySelectorAll("#home-list .song-row").length === 2);
  songRow("home-list", "Big Song").querySelector("button.song-main").dispatchEvent(new win.Event("click", { bubbles: true }));
  await sleep(150);
  check("playing the selected first song", /Big Song/.test($("np-title").textContent), $("np-title").textContent);
  check("media element streams the device file",
    /vocalpure\.local\/audio\?path=/.test(win.document.querySelector("audio").src), win.document.querySelector("audio").src);
  check("AI worklet node created", MockWorkletNode.instances.length === 1 && MockWorkletNode.instances[0].name === "vp-ai-voice",
    MockWorkletNode.instances.length + " node(s)");
  const firstParams = workletParams.find((m) => m && m.t === "params");
  /* the default separation strength is now "max" — 100% isolation */
  check("engine params sent (default strength is max/100% isolation)", !!firstParams && firstParams.strength === "max" && typeof firstParams.capture === "boolean",
    JSON.stringify(firstParams || {}));
  /* the worklet announces itself; only then does the app consider the engine live */
  const readyPort = MockWorkletNode.instances[0].port.onmessage;
  readyPort({ data: { t: "ready", engine: "vp-ai-v6", sr: 48000, fft: 1024, hop: 256, latencyMs: 21.3, strengths: ["soft", "balanced", "strong", "max"] } });
  await sleep(20);
  check("engine ready upgrades the UI to the live state",
    /pure voice/i.test($("np-mode-chip").textContent) && /AI/.test($("engine-line").textContent),
    $("np-mode-chip").textContent + " · " + $("engine-line").textContent.slice(0, 60));

  console.log("\nVoice-only contract in the UI");
  const body = win.document.body.innerHTML;
  const leftover = body.match(/<button[^>]*(mode-btn|stem|karaoke|mix)[^>]*>/i);
  check("no music/mode control in the markup", !leftover, leftover ? leftover[0].slice(0, 60) : "");
  check("now-playing chip says pure voice", /pure voice/i.test($("np-mode-chip").textContent), $("np-mode-chip").textContent);
  check("engine line names the AI engine", /AI/i.test($("engine-line").textContent), $("engine-line").textContent.slice(0, 70));

  console.log("\nLive AI meters (stats → UI)");
  const onMessage = MockWorkletNode.instances[0].port.onmessage;
  onMessage({ data: { t: "stats", engine: "vp-ai-v6", voice: 0.62, cutDb: -18.4, f0: 186, vad: 0.7, mono: false, frames: 46, latencyMs: 21.3 } });
  check("voice meter updated", $("np-voice-val").textContent === "62%", $("np-voice-val").textContent);
  check("music-cut meter updated", /18/.test($("np-cut-val").textContent), $("np-cut-val").textContent);
  check("pitch readout updated", /186/.test($("np-ai-pitch").textContent), $("np-ai-pitch").textContent);
  check("engine state shown", /voice/i.test($("np-ai-state").textContent), $("np-ai-state").textContent);
  check("latency readout updated", /21/.test($("np-ai-latency").textContent), $("np-ai-latency").textContent);

  console.log("\nAI controls");
  win.document.querySelector('.ai-btn[data-ai="strong"]').dispatchEvent(new win.Event("click", { bubbles: true }));
  await sleep(20);
  check("strength button reaches the engine", workletParams.some((m) => m && m.t === "params" && m.strength === "strong"));
  check("active strength button highlighted", win.document.querySelector('.ai-btn[data-ai="strong"]').classList.contains("is-active"));
  win.document.querySelector('.ai-btn[data-ai="precision"]').dispatchEvent(new win.Event("click", { bubbles: true }));
  await sleep(20);
  check("4K precision button selects the maximum engine path",
    workletParams.some((m) => m && m.t === "params" && m.strength === "max") &&
    win.document.querySelector('.ai-btn[data-ai="precision"]').classList.contains("is-active"));
  setInput($("np-voice-boost"), 12);
  check("voice boost reflected in the UI", /12/.test($("np-voice-boost-val").textContent), $("np-voice-boost-val").textContent);
  click("np-denoise");
  check("denoise switch posts gateOn=false", workletParams.some((m) => m && m.t === "params" && m.gateOn === false));

  console.log("\nTransport");
  const progress = $("np-progress");
  progress.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 8, right: 100, bottom: 8 });
  const pointer = (type, x) => {
    const e = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clientX", { value: x });
    Object.defineProperty(e, "pointerId", { value: 1 });
    progress.dispatchEvent(e);
  };
  pointer("pointerdown", 20);
  pointer("pointermove", 80);
  pointer("pointerup", 80);
  check("dragging the seek bar moves the media element", win.document.querySelector("audio").currentTime > 0,
    String(win.document.querySelector("audio").currentTime));
  click("btn-play");
  await sleep(20);
  click("btn-next");
  await sleep(120);
  check("next track loads", /Second/.test($("np-title").textContent), $("np-title").textContent);
  click("btn-prev");
  await sleep(120);
  click("btn-shuffle");
  check("shuffle toggles", $("btn-shuffle").classList.contains("is-active"));
  click("btn-repeat");
  check("repeat toggles", $("btn-repeat").classList.contains("is-active"));

  console.log("\nPinned notification (native media bridge)");
  check("notification received the current track metadata",
    mediaCalls.meta.length > 0 && /Big Song|Second/.test(mediaCalls.meta[mediaCalls.meta.length - 1].t),
    JSON.stringify(mediaCalls.meta.slice(-1)));
  check("play state ticks carry position + duration",
    mediaCalls.state.some((s) => s.p === true && s.dur > 0), JSON.stringify(mediaCalls.state.slice(-1)));
  check("audio focus is requested while playing", mediaCalls.focusReq > 0, mediaCalls.focusReq + " request(s)");
  check("wake lock engaged during playback", mediaCalls.playing.indexOf(true) >= 0);
  win.onNativeMediaAction("pause");
  await sleep(20);
  check("notification 'pause' stops playback", win.document.querySelector("audio").paused === true);
  check("paused state pushed to the foreground service", mediaCalls.state.some((s) => s.p === false));
  win.onNativeMediaAction("play");
  await sleep(60);
  check("notification 'play' resumes playback", win.document.querySelector("audio").paused === false);
  win.onNativeMediaAction("seek:5000");
  await sleep(20);
  check("notification seek moves the position", Math.abs(win.document.querySelector("audio").currentTime - 5) < 0.01,
    String(win.document.querySelector("audio").currentTime));

  console.log("\nAudio output routing");
  check("output selector exists in settings", !!$("set-audio-output") && $("set-audio-output").value === "auto",
    $("set-audio-output") ? $("set-audio-output").value : "missing");
  setInput($("set-audio-output"), "speaker");
  check("settings change routes natively", mediaCalls.output[mediaCalls.output.length - 1] === "speaker",
    JSON.stringify(mediaCalls.output));
  setInput($("set-audio-output"), "bluetooth");
  check("bluetooth is selected", $("set-audio-output").value === "bluetooth");
  win.onNativeMediaAction("bt:disconnected");
  await sleep(20);
  check("Bluetooth disconnect falls back to the loudspeaker",
    $("set-audio-output").value === "speaker" && mediaCalls.output[mediaCalls.output.length - 1] === "speaker",
    $("set-audio-output").value);
  win.onNativeMediaAction("output-sync:earpiece");
  check("native output cycling is mirrored in the settings UI", $("set-audio-output").value === "earpiece");
  setInput($("set-audio-output"), "auto");
  check("back to auto routing", mediaCalls.output[mediaCalls.output.length - 1] === "auto");

  console.log("\nSearch / settings / EQ / theme");
  win.document.querySelector('.tab[data-screen="search"]').dispatchEvent(new win.Event("click", { bubbles: true }));
  check("search screen visible", !$("screen-search").hidden);
  setInput($("search-input"), "second");
  check("search filters rows", win.document.querySelectorAll("#search-list .song-row").length === 1,
    win.document.querySelectorAll("#search-list .song-row").length);
  win.document.querySelector('.tab[data-screen="settings"]').dispatchEvent(new win.Event("click", { bubbles: true }));
  setInput($("set-ai-strength"), "max");
  check("settings strength applies", workletParams.some((m) => m && m.t === "params" && m.strength === "max"));
  setInput($("set-ai-boost"), 9);
  check("settings boost value shown", /9/.test($("set-ai-boost-val").textContent), $("set-ai-boost-val").textContent);
  click("btn-ai-relearn");
  check("re-learn resets the engine", workletParams.some((m) => m && m.t === "params" && m.reset === true));
  setInput($("set-volume"), 55);
  check("volume applied", /55/.test($("set-volume-val").textContent), $("set-volume-val").textContent);
  setInput($("set-rate"), 1.25);
  check("speed applied to the media element", win.document.querySelector("audio").playbackRate === 1.25);
  setInput($("eq-1"), 6);
  check("EQ band value shown", /6/.test($("eq-val-1").textContent), $("eq-val-1").textContent);
  setInput($("eq-preset"), "vocal");
  check("EQ preset kept", $("eq-preset").value === "vocal");
  const ocean = win.document.querySelector('.theme[data-theme="ocean"]');
  ocean.dispatchEvent(new win.Event("click", { bubbles: true }));
  check("theme accent applied", win.document.documentElement.style.getPropertyValue("--accent") === "#38bdf8",
    win.document.documentElement.style.getPropertyValue("--accent"));
  click("btn-check-updates");
  await sleep(30);

  console.log("\nImport");
  const input = $("file-input");
  const big = file("Artist - Imported Song.mp3", 42 * 1024 * 1024);
  Object.defineProperty(input, "files", { value: [big], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(200);
  check("imported song listed", !!songRow("home-list", "Imported Song"));
  songRow("home-list", "Imported Song").querySelector("button.song-main").dispatchEvent(new win.Event("click", { bubbles: true }));
  await sleep(150);
  check("imported song streams from a blob: url", win.document.querySelector("audio").src.startsWith("blob:"),
    win.document.querySelector("audio").src.slice(0, 32));
  const huge = file("Huge - TwoHour.mp3", 500 * 1024 * 1024);
  Object.defineProperty(input, "files", { value: [huge], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(150);
  check("oversized file skipped without a crash", errors.length === 0, errors.slice(0, 2).join(" | "));

  console.log("\nCover art (embedded in the audio file)");
  const impRow = songRow("home-list", "Imported Song");
  check("song without embedded art shows the default artwork in its row",
    !!impRow && !!impRow.querySelector(".song-cover.vp-default-art"));
  check("now-playing falls back to the built-in default artwork",
    /data:image\/svg\+xml/.test(win.document.getElementById("np-art").style.backgroundImage || ""),
    (win.document.getElementById("np-art").style.backgroundImage || "").slice(0, 40));

  /* a real ID3v2.4 MP3 carrying an embedded APIC PNG cover */
  const png = new Uint8Array([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A, 0,0,0,13, 0x49,0x48,0x44,0x52,
    0,0,0,1, 0,0,0,1, 8,6,0,0,0, 0x1F,0x15,0xC4,0x89, 0,0,0,13, 0x49,0x44,0x41,0x54,
    0x78,0xDA,0x63,0xFC,0xCF,0xC0,0,0,0,2,0,1,0xE2,0x21,0xBC,0x33, 0,0,0,0,
    0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82]);
  const u32b = (v) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const csz = (s) => { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
  const catB = (...ps) => { const n = ps.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of ps) { o.set(p, k); k += p.length; } return o; };
  const apicPayload = catB(new Uint8Array([3]), csz("image/png"), new Uint8Array([3]), csz("Cover"), png);
  const apicFrame = catB(new Uint8Array([0x41, 0x50, 0x49, 0x43]), u32b(apicPayload.length), new Uint8Array([0, 0]), apicPayload);
  const id3Tag = catB(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]), u32b(apicFrame.length), apicFrame);
  const coveredBytes = catB(id3Tag, new Uint8Array(1024));
  const covFile = new win.File([coveredBytes], "Artist - Covered Song.mp3", { type: "audio/mpeg" });
  Object.defineProperty(covFile, "size", { value: coveredBytes.length });
  Object.defineProperty(input, "files", { value: [covFile], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(700);
  const covRow = songRow("home-list", "Covered Song");
  const covArt = covRow && covRow.querySelector(".song-cover");
  check("embedded ID3v2 cover art is extracted from the imported MP3",
    !!covArt && !covArt.classList.contains("vp-default-art") &&
    /data:image\/png;base64/.test(covArt.style.backgroundImage || ""),
    covArt ? (covArt.style.backgroundImage || "").slice(0, 44) : "row missing");
  covRow.querySelector("button.song-main").dispatchEvent(new win.Event("click", { bubbles: true }));
  await sleep(200);
  check("now-playing shows the extracted cover",
    /data:image\/png;base64/.test(win.document.getElementById("np-art").style.backgroundImage || ""),
    (win.document.getElementById("np-art").style.backgroundImage || "").slice(0, 44));
  check("the cover was pushed to the pinned notification",
    mediaCalls.meta.some((m) => m.t === "Covered Song" && m.art > 0),
    JSON.stringify(mediaCalls.meta.filter((m) => m.t === "Covered Song")));

  console.log("\nExport (captured while playing)");
  click("exp-voice");
  await sleep(30);
  check("export enables engine capture", workletParams.some((m) => m && m.t === "params" && m.capture === true));
  check("export button switches to stop", /stop/i.test($("exp-voice").textContent), $("exp-voice").textContent);
  onMessage({ data: { t: "pcm", samples: 96000, data: new Uint8Array(2 * 48000 * 2 * 2).buffer } });
  await sleep(20);
  check("PCM chunks written to the file", written.length > 0, written.length + " write(s)");
  click("exp-voice");
  await sleep(30);
  check("export finalises the WAV header", written.some((w) => w.last));

  console.log("\nLibrary management");
  const del = songRow("home-list").querySelector(".del-btn");
  if (del) { del.dispatchEvent(new win.Event("click", { bubbles: true })); await sleep(40); }
  win.document.querySelector('.tab[data-screen="playlists"]').dispatchEvent(new win.Event("click", { bubbles: true }));
  click("btn-new-playlist");
  await sleep(30);
  check("playlists screen works", errors.length === 0, errors.slice(0, 2).join(" | "));
  win.document.querySelector('.tab[data-screen="home"]').dispatchEvent(new win.Event("click", { bubbles: true }));
  click("btn-clear-library");
  await sleep(80);
  check("clearing the library leaves no errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log("\nFail-closed engine (WebView without AudioWorklet)");
  const F = boot({ worklet: false });
  const fw = F.win;
  await sleep(700);
  check("boots without AudioWorklet", F.errors.length === 0, F.errors.slice(0, 2).join(" | "));
  check("no worklet node created in fail-closed mode", F.MockWorkletNode.instances.length === 0);
  const frow = fw.document.querySelector("#home-list .song-row button.song-main");
  check("library still filled in fail-closed mode", !!frow);
  if (frow) {
    frow.dispatchEvent(new fw.Event("click", { bubbles: true }));
    await sleep(150);
    const ftitle = (fw.document.getElementById("np-title") || {}).textContent || "";
    const faudio = fw.document.querySelector("audio");
    check("song still loads (silently — never unfiltered) in fail-closed mode",
      /Big Song|Second/.test(ftitle) && !!faudio && /vocalpure\.local\/audio\?path=/.test(faudio.src),
      ftitle + " · " + (faudio ? faudio.src.slice(0, 44) : "no audio element"));
    const fline = (fw.document.getElementById("engine-line") || {}).textContent || "";
    check("engine failure is announced in the UI", /unavailable|AudioWorklet|WebView/i.test(fline), fline.slice(0, 80));
    const fchip = (fw.document.getElementById("np-mode-chip") || {}).textContent || "";
    check("now-playing chip shows the failure", /unavailable/i.test(fchip), fchip);
    const fstatus = (fw.document.getElementById("set-ai-status") || {}).textContent || "";
    check("settings shows the failure with a retry hint", /Unavailable/.test(fstatus) && /Re-learn/.test(fstatus), fstatus.slice(0, 80));
    const fretry = fw.document.getElementById("btn-ai-relearn");
    if (fretry) {
      fretry.dispatchEvent(new fw.Event("click", { bubbles: true }));
      await sleep(60);
      check("retry keeps the app stable (still failed, no crash)", F.errors.length === 0, F.errors.slice(0, 2).join(" | "));
    }
  }

  console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
  if (errors.length) console.log("runtime errors:\n - " + errors.slice(0, 10).join("\n - "));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("HARNESS CRASH: " + e.stack); process.exit(2); });
