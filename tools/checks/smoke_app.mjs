#!/usr/bin/env node
/* ============================================================
   Headless smoke test of the standalone VocalPure app
   (app/index.html + app/js/*) using jsdom.

   Boots the app with scripts inlined (no audio stack, no IndexedDB
   — both are optional and must degrade gracefully) and exercises:
     - boot without runtime errors, VPApp exposed
     - bottom-tab navigation between the four screens
     - library tab switching (songs / artists / playlists / favorites)
     - playlist creation (in-memory; IndexedDB unavailable in jsdom)
     - settings overlay open/close, strength + keep-screen-on UI
     - mode chips refuse to switch without a loaded song
     - empty states render
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

/* ---- build a self-contained HTML (inline the two scripts) ---- */
let html = readFileSync(path.join(REPO, "app", "index.html"), "utf8");
const iso = readFileSync(path.join(REPO, "app", "js", "isolation.js"), "utf8");
const player = readFileSync(path.join(REPO, "app", "js", "player.js"), "utf8");
html = html.replace('<script src="js/isolation.js"></script>', "<script>\n" + iso + "\n</script>");
html = html.replace('<script src="js/player.js"></script>', "<script>\n" + player + "\n</script>");
if (html.includes('src="js/')) throw new Error("unresolved script src in app html");

/* ---- boot ---- */
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => {
  const msg = String(e && e.message || e);
  // jsdom has no real canvas/audio/navigator.storage — the app guards these,
  // but jsdom still reports the *not implemented* calls. Only true script
  // errors fail the test.
  if (/Not implemented|not implemented/i.test(msg)) return;
  errors.push(msg);
});
vc.on("error", (m) => errors.push(String(m)));

const dom = new JSDOM(html, {
  url: "file:///android_asset/www/index.html",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;
await sleep(150);

check("boots without runtime errors", errors.length === 0, errors.slice(0, 3).join(" | "));
check("VPApp test surface exposed", !!window.VPApp && window.VPApp.version === "3.0.0");
check("starts with an empty library", window.VPApp.state().songs === 0);
check("VPIsolator engine attached to window", !!window.VPIsolator && typeof window.VPIsolator.buildStems === "function");

/* ---- navigation ---- */
function activeScreen() {
  return doc.querySelector(".screen.is-active") && doc.querySelector(".screen.is-active").id;
}
check("library is the start screen", activeScreen() === "screen-library");
for (const tab of ["split", "eq", "queue", "library"]) {
  doc.querySelector('[data-nav="' + tab + '"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  check('tab "' + tab + '" switches screen', activeScreen() === "screen-" + tab);
}

/* ---- library tabs ---- */
const empty = doc.getElementById("lib-empty");
check("songs tab shows the empty state", !empty.hidden && /library is empty/i.test(doc.getElementById("empty-title").textContent));
doc.querySelector('[data-libtab="artists"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
check("artists tab shows the empty state", !empty.hidden && /no playlists|library is empty|no artists|Nothing/i.test(doc.getElementById("empty-title").textContent) || doc.getElementById("artist-list").hidden === false);
doc.querySelector('[data-libtab="playlists"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
check("playlists tab shows playlist creation UI", !doc.getElementById("pl-new").hidden && !doc.getElementById("playlist-list").hidden);

/* ---- playlist creation (in-memory; IDB is absent in jsdom) ---- */
const plName = doc.getElementById("new-playlist-name");
const plAdd = doc.getElementById("new-playlist-add");
plName.value = "Smoke Test Mix";
plAdd.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
check("playlist appears after creation", window.VPApp.state().playlists === 1 && doc.querySelector("#playlist-list .pl-title").textContent === "Smoke Test Mix");

/* ---- favorites tab ---- */
doc.querySelector('[data-libtab="favorites"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
check("favorites tab shows its empty state", !empty.hidden && /favorites/i.test(doc.getElementById("empty-title").textContent));
doc.querySelector('[data-libtab="songs"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

/* ---- settings overlay ---- */
doc.getElementById("btn-settings").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
check("settings overlay opens", !doc.getElementById("settings").hidden);
check("hash-based overlay entry pushed", /#ov1$/.test(window.location.hash));
const strength = doc.getElementById("set-strength");
strength.value = "55";
strength.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(30);
check("isolation strength setting updates live", window.VPApp.state().strength === 55 && doc.getElementById("strength-val").textContent === "55%");
const keep = doc.getElementById("set-keepscreen");
keep.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
check("keep-screen-on toggles", keep.getAttribute("aria-checked") === "true" && keep.classList.contains("is-on"));
doc.getElementById("settings-close").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
check("settings overlay closes via history", doc.getElementById("settings").hidden);

/* ---- mode chips need a song ---- */
const before = window.VPApp.state().mode;
doc.querySelector('#mode-chips [data-mode="karaoke"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(30);
check("mode chips refuse to switch without a song", window.VPApp.state().mode === before);

/* ---- mini player hidden with no song ---- */
check("mini player hidden when nothing plays", doc.getElementById("mini").hidden);

/* ---- search input renders counts ---- */
const search = doc.getElementById("song-search");
search.value = "nothing matches this";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(30);
check("search with no matches shows empty state", !doc.getElementById("lib-empty").hidden);

console.log("");
if (fails) {
  console.error(fails + " check(s) FAILED");
  process.exit(1);
}
console.log("App smoke test passed (" + (errors.length ? "jsdom non-fatal notices: " + errors.length : "clean console") + ").");
dom.window.close();
process.exit(0);
