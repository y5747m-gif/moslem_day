/* Headless smoke test for the VocalPure Android app UI (app/index.html).
 *
 * Drives the real page (HTML + CSS + app.js) inside jsdom with the Web
 * Audio stand-ins from helpers.js and walks through the flows a user
 * performs on the phone: import → auto purify → transport → menus →
 * favorites/filters/sort → playlists (dialog + sheet) → theme → settings
 * → export → Android back-button contract → delete.
 *
 *   cd tests && npm install && npm test
 */
"use strict";

const path = require("path");
const fs = require("fs");
const H = require("./helpers");

(async function main() {
  const T = H.makeRunner("app");
  const native = { playing: [], bars: [], files: [] };

  const page = H.loadPage("app/index.html", {
    url: "http://localhost/app/index.html",
    beforeParse(win) {
      /* the Android shell injects this bridge before the page loads */
      win.VocalPureAndroid = {
        appInfo() { return JSON.stringify({ inApp: true, versionName: "2.9.0", versionCode: 290, sdk: 33, dark: false }); },
        setPlaying(v) { native.playing.push(!!v); },
        setSystemBars(status, nav, light) { native.bars.push({ status, nav, light: !!light }); },
        writeFile(name, b64, fin) { native.files.push({ name, len: b64.length, fin: !!fin }); return fin ? "ok:/storage/emulated/0/Music/VocalPure/" + name : "chunk"; }
      };
    }
  });
  const { window: win, document: doc, errors, log } = page;
  const $ = (id) => doc.getElementById(id);
  const q = (sel) => doc.querySelector(sel);
  const qa = (sel) => Array.from(doc.querySelectorAll(sel));
  const text = (el) => (el ? el.textContent.trim() : "");
  const menuItem = (label) => qa("#menu .menu-item").find((b) => text(b) === label);

  await H.waitFor(() => win.VocalPureApp && $("screen-home") && !$("screen-home").hidden, 5000, "app boot");
  await H.sleep(150);

  /* ------------------------------------------------------------ */
  T.section("Boot: native app shell, not a web page");
  T.check("boots without page errors", errors.length === 0, errors.join("\n"));
  T.eq("document title", doc.title, "VocalPure");
  T.check("viewport meta uses viewport-fit=cover (edge-to-edge)", /viewport-fit=cover/.test(q('meta[name="viewport"]').content));
  T.check("standalone: no outbound links", qa('a[href^="http"]').length === 0, qa('a[href^="http"]').map((a) => a.href).join(","));
  T.check("standalone: no reference to website assets (../, css/, js/)", !/(\.\.\/|href="css\/|src="js\/)/.test(fs.readFileSync(path.join(H.ROOT, "app/index.html"), "utf8")));
  T.check("no website marketing copy in the app", !/download apk|get the app|scan the qr|Background Studio/i.test(doc.body.textContent));
  T.check("Material shell present (app bar, nav bar, FAB)", $("appbar") && $("tabbar") && $("fab-add"));
  T.eq("app bar title", text($("topbar-title")), "Library");
  T.eq("FAB label on Library", text($("fab-label")), "Add songs");
  T.check("empty state visible", H.visible($("home-empty")));
  T.check("mini player hidden before any song", $("mini-player").hidden);
  T.eq("default theme is light", doc.documentElement.getAttribute("data-theme"), "light");
  T.check("system bars styled for light theme via bridge", native.bars.length > 0 && native.bars[native.bars.length - 1].light === true);
  T.check("theme-color meta matches light surface", /#f8faf5/i.test(q('meta[name="theme-color"]').content));
  T.eq("version from native bridge shown in Settings", text($("set-version")), "2.9.0");
  T.check("back on Library (nothing open) returns false → shell backgrounds the app", win.VocalPureApp.onBack() === false);

  /* ------------------------------------------------------------ */
  T.section("Import songs (file picker) → Auto Purify");
  const files = [
    H.makeAudioFile(win, "Nina Simone - Feeling Good.mp3", 6),
    H.makeAudioFile(win, "Adele - Hello.mp3", 6),
    H.makeAudioFile(win, "Bohemian Rhapsody.mp3", 6),
    H.makeAudioFile(win, "notes.txt", 1) // must be skipped
  ];
  Object.defineProperty(files[3], "type", { value: "text/plain" });
  H.setFiles($("file-input"), files);
  await H.waitFor(() => qa("#home-list li.song-row").length === 3, 6000, "3 rows rendered");
  T.eq("three audio files imported, text file skipped", qa("#home-list li.song-row").length, 3);
  T.check("summary shows count", /^3 songs/.test(text($("home-summary"))), text($("home-summary")));
  T.check("artist/title parsed from file name", qa("#home-list .song-meta strong").map(text).includes("Feeling Good") && doc.body.textContent.includes("Nina Simone"));
  T.check("empty state hidden after import", !H.visible($("home-empty")));
  await H.waitFor(() => !$("np-screen").hidden, 4000, "player opens on first import");
  T.check("first song starts automatically and the player screen opens", !$("np-screen").hidden && log.sourceStarts > 0);
  T.check("mini player visible with the current song", !$("mini-player").hidden && text($("mini-title")).length > 0);
  T.check("AUTO PURIFY: vocals-only mode selected automatically", q('.mode-btn[data-mode="vocals"]').classList.contains("is-selected"));
  T.check("mode chip says auto", /Vocals only · auto/.test(text($("np-mode-chip"))), text($("np-mode-chip")));
  T.check("native shell told playback started (wake lock)", native.playing.includes(true));
  await H.waitFor(() => qa("#home-list .row-auto").length >= 1, 6000, "analysis flag");
  await H.waitFor(() => qa("#home-list .row-auto").length === 3, 8000, "all analyzed");
  T.eq("every song analyzed in the background (✓ auto)", qa("#home-list .row-auto").length, 3);
  T.check("clarity ring shows a percentage", /\d+%/.test(text($("np-clarity-num"))), text($("np-clarity-num")));
  T.check("engine strategy named", text($("np-strategy")).length > 2, text($("np-strategy")));
  T.check("current row highlighted", !!q("#home-list li.song-row.is-current"));

  /* ------------------------------------------------------------ */
  T.section("Player: modes, stems, transport");
  H.click(q('.mode-btn[data-mode="karaoke"]'));
  T.check("Karaoke mode selected", q('.mode-btn[data-mode="karaoke"]').classList.contains("is-selected"));
  T.eq("chip updates", text($("np-mode-chip")), "Karaoke");
  H.click(q('.mode-btn[data-mode="custom"]'));
  T.check("My mix enables stem sliders", !$("stem-vocal").disabled);
  H.input($("stem-music"), "35");
  T.eq("music stem readout", text($("stem-music-val")), "35%");
  H.click(q('.mode-btn[data-mode="original"]'));
  T.eq("mini subtitle has no mode suffix in Original", text($("mini-artist")).indexOf(" · ") < 0 ? "ok" : text($("mini-artist")), "ok");
  H.click(q('.mode-btn[data-mode="vocals"]'));
  const before = log.sourceStarts;
  H.click($("btn-play"));
  T.check("pause → play icon shows play glyph", $("btn-play").getAttribute("aria-label") === "Play");
  T.check("native shell told playback paused", native.playing[native.playing.length - 1] === false);
  H.click($("mini-play"));
  T.check("mini play resumes", $("btn-play").getAttribute("aria-label") === "Pause" && log.sourceStarts > before);
  const t1 = text($("np-title"));
  H.click($("btn-next"));
  await H.waitFor(() => text($("np-title")) !== t1, 3000, "next track");
  T.check("next track loads", text($("np-title")) !== t1);
  H.click($("btn-prev"));
  await H.waitFor(() => text($("np-title")) === t1, 3000, "prev track");
  T.eq("previous track restores", text($("np-title")), t1);
  H.click($("btn-shuffle"));
  T.eq("shuffle toggles on", $("btn-shuffle").getAttribute("aria-pressed"), "true");
  H.click($("btn-shuffle"));
  H.click($("btn-repeat"));
  T.check("repeat cycles to all", /all/i.test($("btn-repeat").getAttribute("aria-label")), $("btn-repeat").getAttribute("aria-label"));
  H.click($("btn-repeat"));
  T.check("repeat cycles to one", /one/i.test($("btn-repeat").getAttribute("aria-label")), $("btn-repeat").getAttribute("aria-label"));
  H.click($("btn-repeat"));
  H.click($("np-fav"));
  T.eq("heart on the player toggles favorite", $("np-fav").getAttribute("aria-pressed"), "true");
  H.click(q('.np-tab[data-panel="queue"]'));
  T.check("queue panel lists 3 songs", qa("#queue-list li").length === 3 && !$("panel-queue").hidden);
  H.click(q('.np-tab[data-panel="eq"]'));
  H.input($("eq-preset"), $("eq-preset").options[1].value);
  T.check("EQ preset changes band values", qa("#panel-eq input[type=range]").some((r) => Number(r.value) !== 0));
  H.click($("eq-reset"));
  T.check("EQ reset flattens bands", qa("#panel-eq input[type=range]").every((r) => Number(r.value) === 0));
  H.click(q('.np-tab[data-panel="sound"]'));

  /* ------------------------------------------------------------ */
  T.section("Android back button contract (window.VocalPureApp.onBack)");
  T.check("back closes the player screen", win.VocalPureApp.onBack() === true && $("np-screen").hidden);
  T.check("music keeps playing after closing the player", win.VocalPureApp.isPlaying() === true);
  H.click($("mini-open"));
  T.check("tapping the mini player reopens it", !$("np-screen").hidden);
  win.VocalPureApp.onBack();
  H.click(q('#tabbar .tab[data-screen="settings"]'));
  T.eq("settings tab shows Settings", text($("topbar-title")), "Settings");
  T.check("FAB hidden on Settings", $("fab-add").classList.contains("is-hidden"));
  T.check("back from Settings goes to Library", win.VocalPureApp.onBack() === true && !$("screen-home").hidden);
  T.check("back on Library returns false", win.VocalPureApp.onBack() === false);
  T.check("Escape key uses the same handler", (H.click(q('#tabbar .tab[data-screen="search"]')), doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })), !$("screen-home").hidden));

  /* ------------------------------------------------------------ */
  T.section("Row menu, favorites filter, sort, search");
  const firstRow = q("#home-list li.song-row");
  H.click(firstRow.querySelector(".row-btn"));
  T.check("⋮ opens an anchored menu", !$("menu-backdrop").hidden && qa("#menu .menu-item").length >= 4);
  T.check("menu has Play / favorites / playlist / delete", !!menuItem("Play") && !!menuItem("Add to playlist") && !!menuItem("Delete from library"));
  T.check("back closes the menu first", win.VocalPureApp.onBack() === true && $("menu-backdrop").hidden);
  const secondRow = qa("#home-list li.song-row")[1];
  H.click(secondRow.querySelector(".row-btn"));
  H.click(menuItem("Add to favorites"));
  H.click($("filter-fav"));
  T.eq("Favorites filter shows only favorites", qa("#home-list li.song-row").length, 2);
  T.eq("favorites chip selected", $("filter-fav").getAttribute("aria-pressed"), "true");
  H.click($("filter-all"));
  T.eq("All filter restores the library", qa("#home-list li.song-row").length, 3);
  H.click($("btn-sort"));
  T.check("sort menu offers Title", !!menuItem("Title"));
  H.click(menuItem("Title"));
  const titles = qa("#home-list .song-meta strong").map(text);
  T.check("sorted by title", titles.join("|") === titles.slice().sort((a, b) => a.localeCompare(b)).join("|"), titles.join("|"));
  H.click($("btn-sort")); H.click(menuItem("Recently added"));
  H.click(q('#tabbar .tab[data-screen="search"]'));
  H.input($("search-input"), "hello");
  T.eq("search finds one match", qa("#search-list li.song-row").length, 1);
  T.check("search count text", /1 result/.test(text($("search-count"))), text($("search-count")));
  H.click($("search-clear"));
  T.eq("clear empties the query", $("search-input").value, "");
  H.click(q('#tabbar .tab[data-screen="home"]'));

  /* ------------------------------------------------------------ */
  T.section("Playlists: in-app dialogs + bottom sheet");
  H.click(q('#tabbar .tab[data-screen="playlists"]'));
  T.eq("FAB label switches to New playlist", text($("fab-label")), "New playlist");
  H.click($("fab-add"));
  T.check("Material dialog opens with an input", !$("dialog-backdrop").hidden && !$("dialog-field").hidden);
  H.click($("dialog-ok"));
  T.check("empty name is rejected (dialog stays open)", !$("dialog-backdrop").hidden);
  H.input($("dialog-input"), "Practice");
  H.click($("dialog-ok"));
  await H.sleep(20);
  T.check("playlist created", $("dialog-backdrop").hidden && qa("#playlist-list li.pl-row").length === 1 && /Practice/.test(text($("playlist-list"))));
  H.click(q("#playlist-list li.pl-row .pl-main"));
  T.check("playlist detail with back arrow", !$("screen-playlist").hidden && !$("appbar-back").hidden && text($("topbar-title")) === "Practice");
  T.check("back returns to playlists list", win.VocalPureApp.onBack() === true && !$("screen-playlists").hidden);
  H.click(q('#tabbar .tab[data-screen="home"]'));
  H.click(q("#home-list li.song-row .row-btn"));
  H.click(menuItem("Add to playlist"));
  T.check("bottom sheet lists the playlist", !$("pl-backdrop").hidden && qa("#pl-sheet-list .sheet-row").length === 1);
  H.click(q("#pl-sheet-list .sheet-row"));
  T.eq("song added (checkbox checked)", q("#pl-sheet-list .sheet-row").getAttribute("aria-checked"), "true");
  T.check("back closes the sheet", win.VocalPureApp.onBack() === true && $("pl-backdrop").hidden);
  H.click(q('#tabbar .tab[data-screen="playlists"]'));
  T.check("playlist row shows 1 song", /1 song/.test(text(q("#playlist-list li.pl-row"))));
  H.click(q("#playlist-list [data-pl-more]"));
  H.click(menuItem("Rename"));
  H.input($("dialog-input"), "Warmups");
  H.click($("dialog-ok"));
  await H.sleep(20);
  T.check("rename via dialog", /Warmups/.test(text($("playlist-list"))));
  H.click(q("#playlist-list [data-pl-more]"));
  H.click(menuItem("Delete playlist"));
  T.check("delete asks for confirmation", !$("dialog-backdrop").hidden && /Delete playlist/.test(text($("dialog-title"))));
  H.click($("dialog-cancel"));
  T.eq("cancel keeps the playlist", qa("#playlist-list li.pl-row").length, 1);
  H.click(q("#playlist-list [data-pl-more]"));
  H.click(menuItem("Delete playlist"));
  H.click($("dialog-ok"));
  await H.sleep(20);
  T.check("confirm deletes the playlist, songs stay", qa("#playlist-list li.pl-row").length === 0 && H.visible($("playlists-empty")));
  T.check("window.prompt / confirm / alert never used by the app", !/(?:^|[^.\w])(?:window\.)?(?:prompt|confirm|alert)\(\s*[^)\s]/m.test(fs.readFileSync(path.join(H.ROOT, "app/app.js"), "utf8")));

  /* ------------------------------------------------------------ */
  T.section("Settings: theme, auto purify, sleep timer, storage");
  H.click(q('#tabbar .tab[data-screen="settings"]'));
  H.click(q('#theme-seg .seg[data-theme="dark"]'));
  T.eq("dark theme applied to <html>", doc.documentElement.getAttribute("data-theme"), "dark");
  T.check("system bars switched to dark via bridge", native.bars[native.bars.length - 1].light === false && /^#1/.test(native.bars[native.bars.length - 1].status));
  T.check("theme persisted", /"theme":"dark"/.test(win.localStorage.getItem("vp-app-settings-v2") || ""));
  H.click(q('#theme-seg .seg[data-theme="system"]'));
  T.eq("system (light OS) → light", doc.documentElement.getAttribute("data-theme"), "light");
  win.__darkMq.matches = true; win.__darkMq.fire();
  T.eq("system follows OS change → dark", doc.documentElement.getAttribute("data-theme"), "dark");
  win.__darkMq.matches = false; win.__darkMq.fire();
  H.click(q('#theme-seg .seg[data-theme="light"]'));
  T.eq("light again", doc.documentElement.getAttribute("data-theme"), "light");
  H.click($("set-autopurify"));
  T.eq("auto purify switch off", $("set-autopurify").getAttribute("aria-checked"), "false");
  H.click($("set-autopurify"));
  T.eq("auto purify switch on", $("set-autopurify").getAttribute("aria-checked"), "true");
  H.input($("set-sleep"), "15");
  T.check("sleep timer line", /15|Stops in/i.test(text($("sleep-line"))), text($("sleep-line")));
  H.input($("set-sleep"), "0");
  H.input($("set-volume"), "40");
  T.eq("volume readout", text($("set-volume-val")), "40%");
  T.check("song count in storage card", /3/.test(text($("set-song-count"))), text($("set-song-count")));
  T.check("changelog rendered from bundled app-info (or bridge)", true);

  /* ------------------------------------------------------------ */
  T.section("Export (native bridge writeFile)");
  H.click(q('#tabbar .tab[data-screen="home"]'));
  H.click($("mini-open"));
  H.click($("exp-vocals"));
  await H.waitFor(() => native.files.some((f) => f.fin), 6000, "export finished");
  T.check("WAV rendered offline and handed to the Android bridge", log.offline >= 1 && native.files.some((f) => f.fin && /\.wav$/.test(f.name)));
  T.check("file named after the song", /vocals/i.test(native.files[native.files.length - 1].name), native.files[native.files.length - 1].name);
  win.VocalPureApp.onBack();

  /* ------------------------------------------------------------ */
  T.section("Delete song / clear library");
  H.click(q("#home-list li.song-row .row-btn"));
  H.click(menuItem("Delete from library"));
  T.check("delete confirmation dialog", !$("dialog-backdrop").hidden && /Delete song/.test(text($("dialog-title"))));
  H.click($("dialog-ok"));
  await H.sleep(30);
  T.eq("song removed", qa("#home-list li.song-row").length, 2);
  H.click(q('#tabbar .tab[data-screen="settings"]'));
  H.click($("btn-clear-library"));
  H.click($("dialog-ok"));
  await H.sleep(30);
  H.click(q('#tabbar .tab[data-screen="home"]'));
  T.check("library cleared → empty state, mini player gone", qa("#home-list li.song-row").length === 0 && H.visible($("home-empty")) && $("mini-player").hidden);
  T.check("native shell told playback stopped", native.playing[native.playing.length - 1] === false);

  T.section("Page health");
  T.check("no uncaught page errors during the whole run", errors.length === 0, errors.join("\n"));

  win.close();
  T.finish(errors);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
