#!/usr/bin/env node
/* ============================================================================
   VocalPure — website smoke test  ·  tools/smoke_site.js
   ----------------------------------------------------------------------------
   Loads the download site (index.html + js/app.js + js/background.js) in jsdom
   with mocked canvas/observers/fetch and asserts that the live metadata fills
   in, the download links point at the shipped APK, the changelog renders, the
   QR code is produced and no runtime error fires — plus that no removed
   karaoke / two-track / mode wording is promised anywhere in the copy.

   Usage:  npm --prefix tools install     (first time)
           node tools/smoke_site.js
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const TOOLS = __dirname;
const ROOT = path.join(TOOLS, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function loadDep(name) {
  const local = path.join(TOOLS, "node_modules", name);
  if (fs.existsSync(local)) return require(local);
  try { return require(name); } catch (e) { /* fall through */ }
  console.log("Missing test dependency “" + name + "”. Run:  npm --prefix tools install");
  process.exit(2);
}
const { JSDOM } = loadDep("jsdom");

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log((ok ? "  \u2713 " : "  \u2717 ") + name + (detail ? "   [" + detail + "]" : ""));
}

const html = read("index.html").replace(/<script[^>]*><\/script>/g, "");
const dom = new JSDOM(html, { url: "https://vocalpure.local/", pretendToBeVisual: true, runScripts: "outside-only" });
const win = dom.window;
const errors = [];
win.addEventListener("error", (e) => errors.push("window error: " + e.message));
win.console.error = (...a) => errors.push("console.error: " + a.join(" "));
win.console.warn = () => {};

win.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }], this); }
  unobserve() {} disconnect() {}
};
win.BroadcastChannel = class { constructor() {} postMessage() {} close() {} addEventListener() {} };
win.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(read("app-info.json"))) });
win.HTMLCanvasElement.prototype.getContext = () => {
  const noop = () => {};
  const grad = () => ({ addColorStop: noop });
  return { clearRect: noop, fillRect: noop, beginPath: noop, arc: noop, fill: noop, stroke: noop,
    moveTo: noop, lineTo: noop, save: noop, restore: noop, setTransform: noop, transform: noop, scale: noop,
    translate: noop, closePath: noop, roundRect: noop, fillText: noop, createPattern: () => null,
    createLinearGradient: grad, createRadialGradient: grad,
    set fillStyle(v) {}, get fillStyle() { return ""; }, set strokeStyle(v) {}, get strokeStyle() { return ""; },
    set lineWidth(v) {}, get lineWidth() { return 1; }, set globalAlpha(v) {}, get globalAlpha() { return 0; } };
};
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
win.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
win.HTMLMediaElement.prototype.pause = function () {};
win.scrollTo = () => {};

win.eval(read("js/app.js"));
win.eval(read("js/background.js"));

setTimeout(() => {
  const info = JSON.parse(read("app-info.json"));
  const q = (s) => win.document.querySelector(s);
  const txt = win.document.body.textContent;

  console.log("\nMetadata");
  check("version rendered", txt.indexOf(info.version) >= 0 || q('[data-app="version"]').textContent.indexOf(info.versionPlain) >= 0,
    q('[data-app="version"]').textContent);
  check("hero badge shows the version", q("#hero-version").textContent.indexOf(info.versionPlain) >= 0, q("#hero-version").textContent);
  check("size rendered", q('[data-app="size"]').textContent.indexOf(info.size) >= 0, q('[data-app="size"]').textContent);
  check("sha256 rendered", q('[data-app="sha256"]').textContent.indexOf(String(info.sha256).slice(0, 12)) >= 0,
    q('[data-app="sha256"]').textContent.slice(0, 14));
  check("updated date rendered", q('[data-app="updated"]').textContent.indexOf(info.updated) >= 0, q('[data-app="updated"]').textContent);

  console.log("\nDownloads");
  check("stable button points at the shipped APK", q("#dl-stable").getAttribute("href") === info.stableFile,
    q("#dl-stable").getAttribute("href"));
  check("mirror link points at the shipped APK", q("#dl-beta").getAttribute("href") === info.betaFile,
    q("#dl-beta").getAttribute("href"));
  check("stable APK exists on disk", fs.existsSync(path.join(ROOT, info.stableFile)));
  check("changelog rendered", q("#changelog").children.length >= 5, q("#changelog").children.length + " items");
  check("QR code produced", !!q("#dl-qr-img") && !!q("#dl-qr-img").getAttribute("src"));

  console.log("\nCopy contract (no removed features promised)");
  check("no karaoke / two-track / mix wording in the body",
    !/karaoke mode|two-track|two tracks|My mix|four modes/i.test(txt));
  check("no site runtime errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
  if (errors.length) console.log("runtime errors:\n - " + errors.slice(0, 8).join("\n - "));
  process.exit(failures ? 1 : 0);
}, 400);
