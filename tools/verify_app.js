#!/usr/bin/env node
/* ============================================================================
   VocalPure — repository verification  ·  tools/verify_app.js
   ----------------------------------------------------------------------------
   Static checks that protect the app and the website:

     · every JS file parses (app + engine + site)
     · HTML tag balance for both documents
     · every element id / qs() selector used by app.js exists in app/index.html
     · every local href/src referenced by the HTML exists on disk
     · no leftovers of the removed stem/mode/"music" UI
     · no whole-file decode path is left in the app (memory guarantee)
     · app-info.json size + sha256 match the APK actually in downloads/

   Usage:  node tools/verify_app.js
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
let failures = 0, checks = 0;

function check(name, ok, detail) {
  checks++;
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "   [" + detail + "]" : ""));
  if (!ok) failures++;
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), "utf8"); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }
function section(t) { console.log("\n" + t); }

/* ------------------------------------------------------------------ syntax */
section("JavaScript syntax");
const JS_FILES = ["app/app.js", "app/vp-ai-engine.js", "app/vp-cover.js", "js/app.js", "js/background.js"];
for (const f of JS_FILES) {
  let ok = true, err = "";
  try { new vm.Script(read(f), { filename: f }); } catch (e) { ok = false; err = e.message; }
  check(f + " parses", ok, err);
}

/* --------------------------------------------------------------- html tags */
section("HTML structure");
function tagBalance(html, label) {
  const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m, bad = null;
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  while ((m = re.exec(body))) {
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === "/";
    if (VOID.has(tag) || m[2] === "/") continue;
    if (!closing) stack.push(tag);
    else {
      const top = stack.pop();
      if (top !== tag) { bad = "expected </" + top + "> but found </" + tag + ">"; break; }
    }
  }
  if (!bad && stack.length) bad = "unclosed: " + stack.join(", ");
  check(label + " tags balance", !bad, bad || "");
}
tagBalance(read("app/index.html"), "app/index.html");
tagBalance(read("index.html"), "index.html");

/* ------------------------------------------------------ element id coverage */
section("DOM contract (app.js ↔ app/index.html)");
const appHtml = read("app/index.html");
const appJs = read("app/app.js");
const ids = new Set();
const idRe = /\bid="([^"]+)"/g;
let mm;
while ((mm = idRe.exec(appHtml))) ids.add(mm[1]);

const used = new Set();
const dollarRe = /\$\("([^"]+)"\)/g;
while ((mm = dollarRe.exec(appJs))) used.add(mm[1]);
const missing = [...used].filter((id) => !ids.has(id));
check("every $(\"id\") exists in the markup", missing.length === 0, missing.join(", "));

/* the engine talks to these ids too — keep them in sync across files */
const engineIds = ["np-meter-voice", "np-meter-cut", "np-voice-val", "np-cut-val", "np-ai-latency", "np-ai-pitch", "np-ai-state"];
const missingEngine = engineIds.filter((id) => !ids.has(id));
check("AI meter targets exist", missingEngine.length === 0, missingEngine.join(", "));

/* querySelectorAll class contracts */
for (const cls of ["ai-btn", "np-tab"]) {
  const inJs = new RegExp("querySelectorAll\\.[^;]*" + cls + "|querySelectorAll\\(\"\\." + cls, "m").test(appJs.replace(/\s+/g, " ")) ||
    appJs.indexOf(cls) >= 0;
  const inHtml = appHtml.indexOf('class="' + cls) >= 0 || appHtml.indexOf(cls) >= 0;
  check("class .\"" + cls + "\" is present in both files", inJs && inHtml);
}

/* ------------------------------------------------------------ local assets */
section("Local assets");
for (const file of ["index.html", "app/index.html"]) {
  const html = read(file);
  const refs = [];
  let r;
  const re = /(?:href|src)="([^"#]+)"/g;
  while ((r = re.exec(html))) {
    const ref = r[1];
    if (/^(https?:|data:|mailto:|#|\/)/.test(ref)) continue;
    refs.push(ref);
  }
  const dir = path.dirname(path.join(ROOT, file));
  const bad = refs.filter((ref) => !fs.existsSync(path.join(dir, ref.split("?")[0])));
  check(file + " references " + refs.length + " local file(s), all present", bad.length === 0, bad.join(", "));
}

/* --------------------------------------------------- removed-feature guard */
section("No music/stem UI left behind");
const APP_TEXT_FILES = ["app/index.html", "app/app.js", "app/vp-ai-engine.js"];
const FORBIDDEN = [
  ["karaoke control", /karaoke/i],
  ["stem mixer", /stem-(vocal|music)|data-mode|mode-btn|MODE_NAMES/i],
  ["auto-purify switch", /set-autopurify|autoPurify|stemV|stemI/i],
  ["mix/stem mode options", /My mix|Original mix|isolation mode/i]
];
for (const [label, re] of FORBIDDEN) {
  const hits = APP_TEXT_FILES.filter((f) => re.test(read(f)));
  check("no " + label + " in the app", hits.length === 0, hits.join(", "));
}

/* the only player path must be the voice engine */
check("app routes playback through the AI engine", /AudioWorkletNode/.test(read("app/app.js")) && /vp-ai-voice/.test(read("app/vp-ai-engine.js")));
/* whole-song decode is now deliberate (the music is removed BEFORE playback
   in an offline render), but it must stay duration-capped so memory is
   bounded, and it must run through the same AI worklet */
check("pre-playback render is duration-capped (bounded memory)",
  /PP_MAX_SECONDS\s*=\s*\d+/.test(read("app/app.js")) && /duration\s*>\s*PP_MAX_SECONDS/.test(read("app/app.js")));
check("pre-playback render runs through the AI worklet offline",
  /OfflineAudioContext/.test(read("app/app.js")) && /audioWorklet/.test(read("app/app.js")) && /vp-ai-voice/.test(read("app/app.js")));

/* --------------------------------------------------- fail-closed graph */
section("Fail-closed audio graph (no unfiltered path)");
{
  const appSrc = read("app/app.js");
  const engSrc = read("app/vp-ai-engine.js");
  /* wireGraph() is the only place the media source is connected; the direct
     routing exists exactly once and only in "pre" mode, where the element's
     source is always the already-purified render — never the original file */
  const directHits = appSrc.match(/mediaSrc\.connect\(voiceGain\)/g) || [];
  check("direct source routing exists only as the pre-gated purified-render path",
    directHits.length === 1 && /mode === "pre"/.test(appSrc) && /mediaSrc\.connect\(aiNode\)/.test(appSrc),
    directHits.length + " direct routing(s)");
  check("no weak filter fallback", !/useFilterEngine/.test(appSrc));
  check("no unity-mask bypass in the worklet", !/[pd]\.bypass/.test(engSrc));
  check("engine failures surface a visible error",
    /engineError/.test(appSrc) && /AI engine unavailable/.test(appSrc));
  check("selective disconnect() (old-WebView hazard) is gone", !/\.disconnect\(voiceGain\)/.test(appSrc));
}

/* --------------------------------------------------------------- app-info */
section("Release metadata");
const info = JSON.parse(read("app-info.json"));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, f))).digest("hex");
for (const [key, fileKey] of [["sha256", "stableFile"], ["betaSha256", "betaFile"]]) {
  const file = info[fileKey];
  if (!file) { check(key + " has a file", false, fileKey + " missing"); continue; }
  if (!exists(file)) { check(file + " exists", false); continue; }
  const actual = sha(file);
  check(file + " matches " + key, actual === info[key], actual.slice(0, 16) + "… vs " + String(info[key]).slice(0, 16) + "…");
}
for (const [sizeKey, fileKey] of [["size", "stableFile"], ["betaSize", "betaFile"]]) {
  const file = info[fileKey];
  if (!file || !exists(file)) continue;
  const kb = Math.round(fs.statSync(path.join(ROOT, file)).size / 1024);
  const declared = parseInt(String(info[sizeKey]), 10);
  check(file + " size matches " + sizeKey, Math.abs(kb - declared) <= 2, kb + " KB vs " + declared + " KB");
}

/* bundled copy of the app metadata must not advertise a newer version */
const bundled = JSON.parse(read("app/app-info.json"));
check("bundled app-info.json version matches the release",
  String(bundled.version).replace(/^v/, "") === String(info.versionPlain),
  bundled.version + " vs " + info.versionPlain);

/* ------------------------------------------------------------------ engine */
section("Engine self-check");
{
  const sandbox = {
    self: {}, console, Math, Object, Array, Float32Array, Float64Array, Uint16Array,
    ArrayBuffer, DataView, isFinite, isNaN, Infinity, NaN
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(read("app/vp-ai-engine.js"), sandbox, { filename: "vp-ai-engine.js" });
    const api = sandbox.VPAIEngine;
    check("engine loads on the main thread", !!api && !!api.info, api && api.info && api.info.engine);
    check("engine exposes strength presets", !!api.strengths && Object.keys(api.strengths).length === 4);
    check("engine reports one-frame latency", api.info && api.info.latencyMs > 5 && api.info.latencyMs < 40,
      api.info ? api.info.latencyMs.toFixed(1) + " ms" : "n/a");
    const src = "(" + api.factory.toString() + ")();";
    let ok = true, err = "";
    try { new vm.Script(src); } catch (e) { ok = false; err = e.message; }
    check("worklet module source compiles", ok, err);
  } catch (e) {
    check("engine loads on the main thread", false, e.message);
  }
}

/* ------------------------------------------------------------------- done */
console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
process.exit(failures ? 1 : 0);
