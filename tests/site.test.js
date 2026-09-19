/* Headless checks for the download website (repo root index.html).
 *
 * The site must be a download page only — no player — and its download
 * links / metadata must point at the real, signed APK files. It must also
 * not share the app's shell (the app has its own Material UI).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const H = require("./helpers");

(async function main() {
  const T = H.makeRunner("site");
  const info = JSON.parse(fs.readFileSync(path.join(H.ROOT, "app-info.json"), "utf8"));

  /* the page fetches app-info.json — serve it from disk via the mocked fetch */
  const page = H.loadPage("index.html", {
    url: "http://localhost/index.html",
    beforeParse(win) {
      win.fetch = (url) => {
        const u = String(url);
        if (/app-info\.json/.test(u)) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(info) });
        }
        return Promise.reject(new Error("offline: " + u));
      };
      win.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ isIntersecting: true, target: el }]); } unobserve() {} disconnect() {} };
    }
  });
  const { window: win, document: doc, errors } = page;
  const $ = (id) => doc.getElementById(id);
  const qa = (sel) => Array.from(doc.querySelectorAll(sel));
  const text = (el) => (el ? el.textContent.trim() : "");

  await H.waitFor(() => $("dl-stable") && /\.apk$/.test($("dl-stable").getAttribute("href")), 4000, "site boot");
  await H.waitFor(() => text($("hero-version")).indexOf(info.version) >= 0, 4000, "metadata applied");
  await H.sleep(100);

  T.section("Download page metadata (from app-info.json)");
  T.check("no page errors", errors.length === 0, errors.join("\n"));
  T.eq("stable link points at the stable APK", $("dl-stable").getAttribute("href"), info.stableFile);
  T.eq("beta link points at the beta APK", $("dl-beta").getAttribute("href"), info.betaFile);
  T.check("links carry the download attribute", $("dl-stable").hasAttribute("download") && $("dl-beta").hasAttribute("download"));
  T.check("hero badge shows the current version", text($("hero-version")).indexOf(info.version) >= 0, text($("hero-version")));
  T.check("every [data-app=version] shows " + info.version, qa('[data-app="version"]').every((e) => text(e) === info.version));
  T.check("SHA-256 displayed", text($("dl-sha-text") || $("dl-sha")).indexOf(info.sha256.slice(0, 16)) >= 0);
  T.check("changelog rendered from app-info", qa("#changelog li").length === info.changelog.length && text(qa("#changelog li")[0]) === info.changelog[0]);
  T.check("static fallbacks in HTML already mention the current version", (fs.readFileSync(path.join(H.ROOT, "index.html"), "utf8").match(/2\.9\.0/g) || []).length >= 4 && !/2\.8\.0|2\.7\.0/.test(fs.readFileSync(path.join(H.ROOT, "index.html"), "utf8")));
  T.check("js fallback matches current version", new RegExp('version: "' + info.version + '"').test(fs.readFileSync(path.join(H.ROOT, "js/app.js"), "utf8")));

  T.section("APK files on disk match the metadata");
  const stable = path.join(H.ROOT, info.stableFile), beta = path.join(H.ROOT, info.betaFile);
  T.check("stable APK exists", fs.existsSync(stable), stable);
  T.check("beta APK exists", fs.existsSync(beta), beta);
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  T.eq("stable SHA-256 matches", sha(stable), info.sha256);
  T.eq("beta SHA-256 matches", sha(beta), info.betaSha256);
  T.eq("stable size label matches", Math.round(fs.statSync(stable).size / 1024) + " KB", info.size);
  const inApp = JSON.parse(fs.readFileSync(path.join(H.ROOT, "app/app-info.json"), "utf8"));
  T.eq("in-APK app-info.json version matches the release", "v" + inApp.version, info.version);
  T.check("APK is a zip with only app assets (no website files)", (() => {
    const buf = fs.readFileSync(stable);
    const s = buf.toString("latin1");
    return s.indexOf("assets/www/index.html") >= 0 && s.indexOf("assets/www/app.js") >= 0 &&
      s.indexOf("css/style.css") < 0 && s.indexOf("js/background.js") < 0 && s.indexOf("mipmap-anydpi-v26/ic_launcher.xml") >= 0;
  })());

  T.section("The website is not the app");
  T.check("no <audio>/<video> and no Web Audio usage on the site", qa("audio, video").length === 0 && !/AudioContext/.test(fs.readFileSync(path.join(H.ROOT, "js/app.js"), "utf8")));
  T.check("no file input for importing songs", qa('input[type="file"][accept*="audio"]').length === 0);
  T.check("site does not load the app's files", qa('script[src*="app/"], link[href*="app/"], iframe').length === 0);
  T.check("site does not use the app's shell classes", qa("#appbar, #tabbar, #fab-add, #np-screen, .navbar .tab").length === 0);
  T.check("hero mockup previews the app's light Material UI", qa(".phone-app .app-nav").length >= 1 && qa(".phone-app .app-fab").length >= 1);
  T.check("FAQ clarifies the site is only a download page", /just the official download page/i.test(doc.body.textContent));
  T.check("site palette is dark purple/blue; app palette is green Material (distinct)", (() => {
    const site = fs.readFileSync(path.join(H.ROOT, "css/style.css"), "utf8");
    const app = fs.readFileSync(path.join(H.ROOT, "app/style.css"), "utf8");
    return /#a855f7/i.test(site) && /#1b6b4a/i.test(app) && !/#a855f7/i.test(app) && !/Space Grotesk/i.test(app);
  })());

  T.section("Page health");
  T.check("no uncaught page errors", errors.length === 0, errors.join("\n"));

  win.close();
  T.finish(errors);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
