/* ============================================================
   VocalPure — site logic: nav, reveal, downloads, live demo
   Vanilla JS, no dependencies. All features degrade gracefully.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- toast ---------------- */
  var toastWrap = document.getElementById("toast-wrap");
  function toast(msg, type) {
    if (!toastWrap) return;
    while (toastWrap.children.length >= 3) {
      toastWrap.removeChild(toastWrap.firstChild);
    }
    var el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = msg;
    toastWrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity .4s, transform .4s";
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 450);
    }, 3000);
  }
  window.VocalPure = window.VocalPure || {};
  window.VocalPure.toast = toast;

  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  /* ---------------- header + mobile nav ---------------- */
  var header = $("site-header");
  function updateHeader() {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 24);
  }
  window.addEventListener("scroll", updateHeader, { passive: true });
  updateHeader();

  var navToggle = $("nav-toggle");
  var mainNav = $("main-nav");
  if (navToggle && mainNav) {
    navToggle.addEventListener("click", function () {
      var open = mainNav.classList.toggle("open");
      navToggle.classList.toggle("open", open);
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
      navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    mainNav.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a") : null;
      if (a && mainNav.classList.contains("open")) {
        mainNav.classList.remove("open");
        navToggle.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && mainNav.classList.contains("open")) {
        mainNav.classList.remove("open");
        navToggle.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
        navToggle.focus();
      }
    });
  }

  /* ---------------- reveal on scroll ---------------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          entries[i].target.classList.add("visible");
          io.unobserve(entries[i].target);
        }
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    for (var r = 0; r < revealEls.length; r++) io.observe(revealEls[r]);
  } else {
    for (var f = 0; f < revealEls.length; f++) revealEls[f].classList.add("visible");
  }

  /* ---------------- footer bits ---------------- */
  var yearEl = $("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
  ["link-privacy", "link-terms", "link-contact"].forEach(function (id) {
    on($(id), "click", function (e) {
      e.preventDefault();
      toast("This page is not part of the demo site yet — the app itself is what matters.");
    });
  });

  /* ---------------- app info + downloads ---------------- */
  var FALLBACK_INFO = {
    version: "v2.6.0",
    versionPlain: "2.6.0",
    betaVersion: "v2.7.0-beta.1",
    size: "—",
    betaSize: "—",
    updated: "Sep 18, 2026",
    minAndroid: "8.0+",
    sha256: "…",
    stableFile: "downloads/VocalPure-v2.6.0.apk",
    betaFile: "downloads/VocalPure-v2.7.0-beta.1.apk"
  };

  function fillAppInfo(info) {
    var map = {
      version: info.version, versionPlain: info.versionPlain,
      size: info.size, betaSize: info.betaSize, updated: info.updated,
      minAndroid: info.minAndroid, sha256: info.sha256
    };
    var els = document.querySelectorAll("[data-app]");
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute("data-app");
      if (map[key] !== undefined && map[key] !== null) els[i].textContent = map[key];
    }
    var hv = $("hero-version");
    if (hv && info.version) hv.textContent = info.version + " · Android " + (info.minAndroid || "8.0+") + " · 100% Free";
    var dlStable = $("dl-stable"), dlBeta = $("dl-beta");
    if (dlStable && info.stableFile) dlStable.setAttribute("href", info.stableFile);
    if (dlBeta && info.betaFile) dlBeta.setAttribute("href", info.betaFile);
    if (info.changelog && info.changelog.length) {
      var cl = $("changelog");
      if (cl) {
        cl.innerHTML = "";
        info.changelog.forEach(function (item) {
          var li = document.createElement("li");
          li.textContent = item;
          cl.appendChild(li);
        });
      }
    }
    setupQr(info.stableFile || FALLBACK_INFO.stableFile);
  }

  function setupQr(stableFile) {
    var img = $("dl-qr-img");
    if (!img) return;
    var url = stableFile;
    try { url = new URL(stableFile, window.location.href).href; } catch (e) { /* keep relative */ }
    var qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=8&data=" + encodeURIComponent(url);
    img.onerror = function () {
      img.style.display = "none";
      var p = img.parentElement ? img.parentElement.querySelector("p") : null;
      if (p) p.textContent = "QR unavailable offline — use the Download APK button instead.";
    };
    img.src = qrUrl;
    img.alt = "QR code linking to " + url;
  }

  if (window.fetch) {
    fetch("app-info.json", { cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("info " + res.status); return res.json(); })
      .then(function (data) { fillAppInfo(Object.assign({}, FALLBACK_INFO, data)); })
      .catch(function () { fillAppInfo(FALLBACK_INFO); });
  } else {
    fillAppInfo(FALLBACK_INFO);
  }

  /* ---- inside the Android app: adjust the download center ---- */
  if (window.VocalPureAndroid && window.VocalPureAndroid.appInfo) {
    try {
      var info = JSON.parse(window.VocalPureAndroid.appInfo());
      var installed = "v" + (info.versionName || "?");
      var dlCard = document.getElementById("dl-stable");
      if (dlCard) {
        dlCard.removeAttribute("href");
        dlCard.removeAttribute("download");
        dlCard.style.pointerEvents = "none";
        dlCard.innerHTML = "✓ Installed — you are running " + installed;
        dlCard.setAttribute("aria-disabled", "true");
      }
      var betaCard = document.getElementById("dl-beta");
      if (betaCard) {
        betaCard.removeAttribute("href");
        betaCard.removeAttribute("download");
        betaCard.style.pointerEvents = "none";
        betaCard.style.opacity = "0.55";
        betaCard.textContent = "You already have the app installed";
      }
      var qr = document.getElementById("dl-qr-img");
      if (qr) qr.style.display = "none";
      var copyBtn = document.getElementById("dl-copy");
      if (copyBtn) copyBtn.style.display = "none";
      var shaBtn = document.getElementById("dl-sha");
      if (shaBtn) shaBtn.style.display = "none";
      var shaText = document.getElementById("dl-sha-text");
      if (shaText) shaText.style.display = "none";
      var hv = document.getElementById("hero-version");
      if (hv) hv.textContent = installed + " · Android 8.0+ · 100% Free";
      document.querySelectorAll("[data-app=\"version\"], [data-app=\"versionPlain\"]").forEach(function (el) {
        el.textContent = info.versionName || el.textContent;
      });
    } catch (e) { /* stay in normal website mode */ }
  }

  on($("dl-copy"), "click", function () {
    var href = ($("dl-stable") && $("dl-stable").getAttribute("href")) || FALLBACK_INFO.stableFile;
    var abs = href;
    try { abs = new URL(href, window.location.href).href; } catch (e) { /* ignore */ }
    function done() { toast("Download link copied to clipboard.", "success"); }
    function fallbackCopy() {
      try {
        var ta = document.createElement("textarea");
        ta.value = abs;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) done(); else toast("Copy failed — long-press the Download button to copy.", "error");
      } catch (err) { toast("Copy failed in this browser.", "error"); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(abs).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
  });

  on($("dl-sha"), "click", function () {
    var t = $("dl-sha-text");
    if (!t) return;
    t.hidden = !t.hidden;
  });

  /* ============================================================
     Music player — Lark-style library + two-track vocal splitter
     ------------------------------------------------------------
     Plays songs like any top music player (library, playlists,
     favorites, shuffle/repeat, sleep timer, equalizer) with one
     exclusive advantage: EVERY song is split into two tracks —
     Track 1 = Vocals (lyrics), Track 2 = Music (instruments) —
     mixed live with independent levels, mute and solo.

     Isolation engine v3 (dual-stem, works on EVERY track):
       · stereo -> center-channel extraction for the vocal stem
                   (band-shaped 85 Hz – 11.5 kHz), side signal +
                   returned bass for the music stem (karaoke keeps
                   its groove)
       · mono   -> frequency-focus fallback (vocal band
                   170 Hz – 4.3 kHz) because mono carries no side
                   signal
       · both stems run through a safety compressor/limiter with
                   makeup gain so nothing ever clips.
     ============================================================ */

  /* ---------- dom refs ---------- */
  var demoFile = $("demo-file");
  var demoBrowse = $("demo-browse");
  var addSongsBtn = $("add-songs-btn");
  var demoDrop = $("demo-drop");
  var demoSynth = $("demo-synth");
  var demoPlay = $("demo-play");
  var demoStop = $("demo-stop");
  var demoVol = $("demo-volume");
  var muteBtn = $("mute-btn");
  var demoProg = $("demo-progress");
  var demoFill = $("demo-progress-fill");
  var demoCur = $("demo-time-cur");
  var demoTotal = $("demo-time-total");
  var demoLabel = $("demo-track-label");
  var npArtist = $("np-artist");
  var npFav = $("np-fav");
  var npDisc = $("np-disc");
  var demoStatus = $("demo-status");
  var demoViz = $("demo-viz");
  var playIcon = $("demo-play-icon");
  var modeBtns = document.querySelectorAll(".mode-btn");
  var libTabBtns = document.querySelectorAll(".lib-tab");
  var npTabBtns = document.querySelectorAll(".np-tab");
  var songSearch = $("song-search");
  var songSort = $("song-sort");
  var songList = $("song-list");
  var songCount = $("song-count");
  var libEmpty = $("lib-empty");
  var playlistBar = $("playlist-bar");
  var playlistList = $("playlist-list");
  var newPlaylistName = $("new-playlist-name");
  var newPlaylistAdd = $("new-playlist-add");
  var btnPrev = $("btn-prev");
  var btnNext = $("btn-next");
  var btnShuffle = $("btn-shuffle");
  var btnRepeat = $("btn-repeat");
  var rateSel = $("playback-rate");
  var sleepSel = $("sleep-timer");
  var sleepLabel = $("sleep-label");
  var stemVocal = $("stem-vocal");
  var stemInst = $("stem-inst");
  var stemVocalVal = $("stem-vocal-val");
  var stemInstVal = $("stem-inst-val");
  var muteVocalBtn = $("mute-vocal");
  var muteInstBtn = $("mute-inst");
  var soloVocalBtn = $("solo-vocal");
  var soloInstBtn = $("solo-inst");
  var exportVocalsBtn = $("export-vocals");
  var exportKaraokeBtn = $("export-karaoke");
  var exportMixBtn = $("export-mix");
  var eqEnabled = $("eq-enabled");
  var eqPreset = $("eq-preset");
  var eqReset = $("eq-reset");
  var queueList = $("queue-list");
  var queueClear = $("queue-clear");
  var queueCount = $("queue-count");
  var miniBar = $("mini-bar");
  var miniInfo = $("mini-info");
  var miniTitle = $("mini-title");
  var miniSub = $("mini-sub");
  var miniPlay = $("mini-play");
  var miniNext = $("mini-next");
  var miniSplit = $("mini-split");
  var plPop = $("pl-pop");
  var eqBandEls = [$("eq-band-0"), $("eq-band-1"), $("eq-band-2"), $("eq-band-3"), $("eq-band-4")];
  var eqValEls = [$("eq-val-0"), $("eq-val-1"), $("eq-val-2"), $("eq-val-3"), $("eq-val-4")];
  var ptabSplit = $("ptab-split"), ptabEq = $("ptab-eq"), ptabQueue = $("ptab-queue");

  /* ---------- small utils ---------- */
  function uid() {
    return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parseName(fileName) {
    var base = String(fileName || "Unknown").replace(/\.[a-z0-9]{2,5}$/i, "").trim() || "Unknown";
    var m = base.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
    if (m) return { artist: m[1], title: m[2] };
    return { artist: "Unknown artist", title: base };
  }
  function coverHue(title) {
    var h = 0, s = String(title || "?");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function coverLetter(title) {
    var t = String(title || "?").trim();
    return (t.charAt(0) || "?").toUpperCase();
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }
  function setStatus(msg, isError) {
    if (!demoStatus) return;
    demoStatus.textContent = msg;
    demoStatus.classList.toggle("error", !!isError);
  }

  /* ---------- persistent player settings ---------- */
  var SETTINGS_KEY = "vocalpure-player-v1";
  var playerSettings = {
    volume: 80, rate: 1, mode: "original",
    stemV: 100, stemI: 100, customV: 70, customI: 70,
    eqOn: true, eq: [0, 0, 0, 0, 0], eqPreset: "normal",
    shuffle: false, repeat: "off"
  };
  function loadPlayerSettings() {
    try {
      var raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var s = JSON.parse(raw) || {};
      for (var k in playerSettings) {
        if (s[k] === undefined || s[k] === null) continue;
        if (k === "eq" && Object.prototype.toString.call(s[k]) === "[object Array]" && s[k].length === 5) {
          playerSettings.eq = s[k].map(function (v) { return Math.max(-12, Math.min(12, Number(v) || 0)); });
        } else {
          playerSettings[k] = s[k];
        }
      }
      if (["original", "vocals", "karaoke", "custom"].indexOf(playerSettings.mode) < 0) playerSettings.mode = "original";
      if (["off", "all", "one"].indexOf(playerSettings.repeat) < 0) playerSettings.repeat = "off";
    } catch (e) { /* defaults */ }
  }
  function savePlayerSettings() {
    try {
      playerSettings.volume = volume; playerSettings.rate = playbackRate;
      playerSettings.mode = mode; playerSettings.stemV = stemV; playerSettings.stemI = stemI;
      playerSettings.customV = customMem.v; playerSettings.customI = customMem.i;
      playerSettings.eqOn = eqOn; playerSettings.eq = eqGains.slice();
      playerSettings.eqPreset = eqPresetName; playerSettings.shuffle = shuffle;
      playerSettings.repeat = repeatMode;
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(playerSettings));
    } catch (e) { /* ignore */ }
  }

  /* ---------- IndexedDB song storage (audio survives reloads) ---------- */
  var IDB_NAME = "vocalpure-db", IDB_STORE = "songs";
  var idbDb = null, idbFailed = false;
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (idbDb) { res(idbDb); return; }
      if (!window.indexedDB) { rej(new Error("no indexedDB")); return; }
      try {
        var req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: "id" });
        };
        req.onsuccess = function () { idbDb = req.result; res(idbDb); };
        req.onerror = function () { rej(req.error || new Error("idb open")); };
        req.onblocked = function () { rej(new Error("idb blocked")); };
      } catch (e) { rej(e); }
    });
  }
  function idbAll() {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        try {
          var tx = db.transaction(IDB_STORE, "readonly");
          var rq = tx.objectStore(IDB_STORE).getAll();
          rq.onsuccess = function () { res(rq.result || []); };
          rq.onerror = function () { rej(rq.error || new Error("idb read")); };
        } catch (e) { rej(e); }
      });
    });
  }
  function idbPut(rec) {
    if (idbFailed || !window.indexedDB) return;
    idbOpen().then(function (db) {
      try {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(rec);
      } catch (e) { idbFailed = true; }
    }).catch(function () { idbFailed = true; });
  }
  function idbDel(id) {
    if (idbFailed || !window.indexedDB) return;
    idbOpen().then(function (db) {
      try {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(id);
      } catch (e) { /* ignore */ }
    }).catch(function () { /* ignore */ });
  }
  function cleanRec(s) {
    return { id: s.id, title: s.title, artist: s.artist, name: s.name, duration: s.duration || 0, blob: s.blob, favorite: !!s.favorite, dateAdded: s.dateAdded || Date.now() };
  }

  /* ---------- playlists (localStorage) ---------- */
  var PLAYLISTS_KEY = "vocalpure-playlists-v1";
  var playlists = [];
  function loadPlaylists() {
    try {
      var raw = window.localStorage.getItem(PLAYLISTS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      playlists = (arr || []).filter(function (p) { return p && p.id && p.name; })
        .map(function (p) { return { id: p.id, name: String(p.name).slice(0, 40), songIds: (p.songIds || []).slice() }; });
    } catch (e) { playlists = []; }
  }
  function savePlaylists() {
    try { window.localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists)); } catch (e) { /* ignore */ }
  }
  function prunePlaylists() {
    var alive = {};
    for (var i = 0; i < library.length; i++) alive[library[i].id] = true;
    for (var p = 0; p < playlists.length; p++) {
      playlists[p].songIds = playlists[p].songIds.filter(function (id) { return alive[id]; });
    }
  }

  /* ---------- library state ---------- */
  var library = []; // {id,title,artist,name,duration,blob,favorite,dateAdded,_buffer}
  var libTab = "songs";
  var searchQuery = "";
  var sortKey = "added";
  var currentViewIds = [];
  var currentId = null;

  function songById(id) {
    for (var i = 0; i < library.length; i++) if (library[i].id === id) return library[i];
    return null;
  }
  function currentSong() { return currentId ? songById(currentId) : null; }

  function viewSongs() {
    var list = library.slice();
    if (libTab === "favorites") list = list.filter(function (s) { return s.favorite; });
    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      list = list.filter(function (s) {
        return (s.title + " " + s.artist).toLowerCase().indexOf(q) >= 0;
      });
    }
    if (sortKey === "title") list.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    else if (sortKey === "artist") list.sort(function (a, b) { return String(a.artist).localeCompare(String(b.artist)); });
    else if (sortKey === "duration") list.sort(function (a, b) { return (b.duration || 0) - (a.duration || 0); });
    else list.sort(function (a, b) { return (b.dateAdded || 0) - (a.dateAdded || 0); });
    return list;
  }

  function renderLibrary() {
    if (!songList) return;
    prunePlaylists();
    var songs = viewSongs();
    currentViewIds = songs.map(function (s) { return s.id; });
    var html = "";
    for (var i = 0; i < songs.length; i++) {
      var s = songs[i];
      var hue = coverHue(s.title);
      var dur = s.duration > 0 ? fmtTime(s.duration) : "–:––";
      html += '<li class="song-row' + (s.id === currentId ? " is-current" + (playing ? " is-playing" : "") : "") + '" data-id="' + escapeHtml(s.id) + '">' +
        '<button type="button" class="song-main" aria-label="Play ' + escapeHtml(s.title) + '">' +
        '<span class="song-cover" style="background:linear-gradient(135deg,hsl(' + hue + ',70%,55%),hsl(' + ((hue + 45) % 360) + ',70%,42%))" aria-hidden="true">' + escapeHtml(coverLetter(s.title)) + "</span>" +
        '<span class="song-meta"><strong>' + escapeHtml(s.title) + "</strong><span>" + escapeHtml(s.artist) + " · " + dur + "</span></span>" +
        '<span class="song-live" aria-hidden="true"><i></i><i></i><i></i></span>' +
        "</button>" +
        '<button type="button" class="row-btn fav-btn' + (s.favorite ? " is-fav" : "") + '" aria-label="Toggle favorite" title="Favorite">' + (s.favorite ? "★" : "☆") + "</button>" +
        '<button type="button" class="row-btn add-btn" aria-label="Add to playlist" title="Add to playlist">＋</button>' +
        '<button type="button" class="row-btn del-btn" aria-label="Remove song" title="Remove">✕</button>' +
        "</li>";
    }
    songList.innerHTML = html;
    var inPlaylists = (libTab === "playlists");
    songList.hidden = inPlaylists;
    if (playlistList) playlistList.hidden = !inPlaylists;
    if (playlistBar) playlistBar.hidden = !inPlaylists;
    if (libEmpty) libEmpty.style.display = (!inPlaylists && !songs.length) ? "" : "none";
    updateCounts(songs.length);
  }

  function updateCounts(n) {
    if (!songCount) return;
    if (!library.length) { songCount.textContent = "No songs yet — add your music to begin."; return; }
    var total = 0, i;
    for (i = 0; i < library.length; i++) total += library[i].duration || 0;
    var mins = Math.round(total / 60);
    if (libTab === "playlists") {
      songCount.textContent = library.length + " song" + (library.length === 1 ? "" : "s") + " · " + playlists.length + " playlist" + (playlists.length === 1 ? "" : "s");
    } else if (libTab === "favorites") {
      songCount.textContent = n + " favorite" + (n === 1 ? "" : "s") + " · " + library.length + " total";
    } else if (searchQuery) {
      songCount.textContent = n + (n === 1 ? " match" : " matches") + " · " + library.length + " total";
    } else {
      songCount.textContent = library.length + " song" + (library.length === 1 ? "" : "s") + (mins > 0 ? " · " + mins + " min" : "");
    }
  }

  function markCurrentRow() {
    if (!songList) return;
    var rows = songList.children;
    for (var i = 0; i < rows.length; i++) {
      var isCur = rows[i].getAttribute("data-id") === currentId;
      rows[i].classList.toggle("is-current", isCur);
      rows[i].classList.toggle("is-playing", isCur && playing);
    }
  }

  function renderPlaylists() {
    if (!playlistList) return;
    prunePlaylists();
    playlistList.innerHTML = "";
    if (!playlists.length) {
      var hint = document.createElement("li");
      hint.className = "pl-hint";
      hint.textContent = "No playlists yet — create one above, then tap ＋ on any song to add it.";
      playlistList.appendChild(hint);
      return;
    }
    playlists.forEach(function (pl) {
      var det = document.createElement("details");
      det.className = "pl-item";
      var sum = document.createElement("summary");
      var nameEl = document.createElement("span");
      nameEl.className = "pl-name";
      nameEl.textContent = pl.name;
      var countEl = document.createElement("span");
      countEl.className = "pl-count";
      countEl.textContent = pl.songIds.length + " song" + (pl.songIds.length === 1 ? "" : "s");
      var playBtn = document.createElement("button");
      playBtn.type = "button"; playBtn.className = "row-btn pl-play";
      playBtn.textContent = "▶"; playBtn.title = "Play playlist"; playBtn.setAttribute("aria-label", "Play playlist " + pl.name);
      playBtn.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        if (!pl.songIds.length) { toast("“" + pl.name + "” is empty — add songs with the ＋ button."); return; }
        playFromList(pl.songIds.slice(), 0);
      });
      var delBtn = document.createElement("button");
      delBtn.type = "button"; delBtn.className = "row-btn pl-del";
      delBtn.textContent = "✕"; delBtn.title = "Delete playlist"; delBtn.setAttribute("aria-label", "Delete playlist " + pl.name);
      delBtn.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        playlists = playlists.filter(function (p) { return p.id !== pl.id; });
        savePlaylists(); renderPlaylists(); renderLibrary();
        toast("Playlist “" + pl.name + "” deleted.");
      });
      sum.appendChild(nameEl); sum.appendChild(countEl);
      sum.appendChild(playBtn); sum.appendChild(delBtn);
      det.appendChild(sum);
      var ul = document.createElement("ul");
      ul.className = "pl-songs";
      if (!pl.songIds.length) {
        var li0 = document.createElement("li");
        li0.className = "pl-empty";
        li0.textContent = "Empty — tap ＋ on any song to add it here.";
        ul.appendChild(li0);
      }
      pl.songIds.forEach(function (sid) {
        var s = songById(sid);
        if (!s) return;
        var li = document.createElement("li");
        li.className = "pl-song";
        var main = document.createElement("button");
        main.type = "button"; main.className = "pl-song-main";
        main.textContent = s.title + " — " + s.artist;
        main.setAttribute("aria-label", "Play " + s.title);
        main.addEventListener("click", function () { playFromList(pl.songIds.slice(), pl.songIds.indexOf(sid)); });
        var rm = document.createElement("button");
        rm.type = "button"; rm.className = "row-btn";
        rm.textContent = "✕"; rm.title = "Remove from playlist"; rm.setAttribute("aria-label", "Remove " + s.title + " from " + pl.name);
        rm.addEventListener("click", function () {
          pl.songIds = pl.songIds.filter(function (x) { return x !== sid; });
          savePlaylists(); renderPlaylists();
        });
        li.appendChild(main); li.appendChild(rm);
        ul.appendChild(li);
      });
      det.appendChild(ul);
      playlistList.appendChild(det);
    });
  }

  function toggleFav(id) {
    var s = songById(id);
    if (!s) return;
    s.favorite = !s.favorite;
    idbPut(cleanRec(s));
    renderLibrary();
    updateFavUI();
    if (s.favorite) toast("“" + s.title + "” added to favorites.", "success");
  }

  function updateFavUI() {
    if (!npFav) return;
    var s = currentSong();
    var fav = !!(s && s.favorite);
    npFav.textContent = fav ? "★" : "☆";
    npFav.classList.toggle("is-fav", fav);
    npFav.disabled = !s;
  }

  function removeSong(id) {
    var s = songById(id);
    if (!s) return;
    var wasCurrent = (id === currentId);
    if (wasCurrent) {
      stopPlayback();
      buffer = null; currentId = null; duration = 0; offsetBase = 0;
      if (demoLabel) { demoLabel.textContent = "No track loaded"; demoLabel.title = ""; }
      if (npArtist) npArtist.textContent = "Add songs to start listening";
      enableTransport(false);
      updateMini(); updateFavUI(); updateProgressUI();
    }
    library = library.filter(function (x) { return x.id !== id; });
    idbDel(id);
    for (var p = 0; p < playlists.length; p++) {
      playlists[p].songIds = playlists[p].songIds.filter(function (x) { return x !== id; });
    }
    savePlaylists();
    queue = queue.filter(function (x) { return x !== id; });
    if (qi >= queue.length) qi = queue.length - 1;
    if (!queue.length) qi = -1;
    renderLibrary(); renderPlaylists(); renderQueue();
    toast("Removed “" + s.title + "”.");
  }

  /* ---------- playlist picker popover ---------- */
  var plPopSongId = null;
  function openPlPop(songId, anchorBtn) {
    if (!plPop) return;
    plPopSongId = songId;
    renderPlPop();
    plPop.hidden = false;
    try {
      var r = anchorBtn.getBoundingClientRect();
      var w = 250, h = plPop.offsetHeight || 200;
      var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
      var top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
      plPop.style.left = left + "px";
      plPop.style.top = top + "px";
    } catch (e) { /* centered fallback via CSS */ }
  }
  function renderPlPop() {
    if (!plPop) return;
    plPop.innerHTML = "";
    var s = songById(plPopSongId);
    var title = document.createElement("p");
    title.className = "pl-pop-title";
    title.textContent = s ? "Add “" + s.title + "” to…" : "Add to playlist";
    plPop.appendChild(title);
    if (!playlists.length) {
      var none = document.createElement("p");
      none.className = "pl-pop-none";
      none.textContent = "No playlists yet — create one in the ▤ Playlists tab.";
      plPop.appendChild(none);
      return;
    }
    playlists.forEach(function (pl) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "pl-pop-row" + (pl.songIds.indexOf(plPopSongId) >= 0 ? " in-list" : "");
      row.textContent = (pl.songIds.indexOf(plPopSongId) >= 0 ? "✓ " : "○ ") + pl.name + " (" + pl.songIds.length + ")";
      row.addEventListener("click", function () {
        var i = pl.songIds.indexOf(plPopSongId);
        if (i >= 0) pl.songIds.splice(i, 1);
        else pl.songIds.push(plPopSongId);
        savePlaylists(); renderPlaylists(); renderPlPop();
      });
      plPop.appendChild(row);
    });
  }
  function closePlPop() { if (plPop) plPop.hidden = true; plPopSongId = null; }

  /* ============================================================
     Audio engine
     Persistent chain: mix -> comp -> eqIn -> 5 bands -> master
                       -> analyser -> destination
     Original mode bypasses mix/comp and feeds eqIn directly.
     ============================================================ */
  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null, master = null, analyser = null, comp = null, mix = null, eqIn = null;
  var eqBands = [];
  var buffer = null, source = null, graphV = null, graphI = null;
  var mode = "original";
  var playing = false;
  var startCtxTime = 0, offsetBase = 0, duration = 0;
  var playbackRate = 1, volume = 80, muted = false;
  var stemV = 100, stemI = 100;
  var muteV = false, muteI = false, soloV = false, soloI = false;
  var customMem = { v: 70, i: 70 };
  var vizRaf = null, freqData = null;
  var accentCache = ["#a855f7", "#22d3ee"];
  var accentTick = 0;
  var exporting = false;

  var ICON_PLAY = "M7 4.5v15l13-7.5z";
  var ICON_PAUSE = "M6 4h4v16H6zM14 4h4v16h-4z";

  function setPlayIcon(isPlaying) {
    if (playIcon) {
      while (playIcon.firstChild) playIcon.removeChild(playIcon.firstChild);
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", isPlaying ? ICON_PAUSE : ICON_PLAY);
      playIcon.appendChild(p);
    }
    if (demoPlay) demoPlay.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    if (npDisc) npDisc.classList.toggle("spinning", isPlaying);
    if (miniPlay) miniPlay.textContent = isPlaying ? "⏸" : "▶";
    markCurrentRow();
  }

  /* ---- stem builders (shared by realtime + offline export) ---- */
  function cGain(C, v) { var g = C.createGain(); g.gain.value = v; return g; }
  function cFilter(C, type, freq, q) {
    var f = C.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    f.Q.value = (q === undefined ? 0.71 : q);
    return f;
  }
  /* Vocal stem: stereo center extraction / mono vocal-band focus */
  function buildVocalChain(C, src, stereo) {
    if (!stereo) {
      var hp = cFilter(C, "highpass", 170), lp = cFilter(C, "lowpass", 4300);
      var pr = cFilter(C, "peaking", 2600, 1.1); pr.gain.value = 2.5;
      var mk = cGain(C, 1.3);
      src.connect(hp); hp.connect(lp); lp.connect(pr); pr.connect(mk);
      return mk;
    }
    var sp = C.createChannelSplitter(2), mg = C.createChannelMerger(2);
    var gL = cGain(C, 0.5), gR = cGain(C, 0.5);
    src.connect(sp);
    sp.connect(gL, 0); sp.connect(gR, 1);
    gL.connect(mg, 0, 0); gR.connect(mg, 0, 0);
    gL.connect(mg, 0, 1); gR.connect(mg, 0, 1);
    var sub = cFilter(C, "highpass", 85), air = cFilter(C, "lowpass", 11500);
    var fo = cFilter(C, "peaking", 2600, 1.1); fo.gain.value = 1.5;
    var vm = cGain(C, 1.35);
    mg.connect(sub); sub.connect(air); air.connect(fo); fo.connect(vm);
    return vm;
  }
  /* Music stem: stereo side + returned bass / mono vocal-band removal */
  function buildInstChain(C, src, stereo) {
    if (!stereo) {
      var sum = cGain(C, 1);
      var lo = cFilter(C, "lowpass", 170), hi = cFilter(C, "highpass", 4300);
      var gl = cGain(C, 1.25), gh = cGain(C, 1.25);
      src.connect(lo); lo.connect(gl); gl.connect(sum);
      src.connect(hi); hi.connect(gh); gh.connect(sum);
      return sum;
    }
    var sp = C.createChannelSplitter(2), mg = C.createChannelMerger(2);
    var a = cGain(C, 0.5), b = cGain(C, -0.5), cc = cGain(C, -0.5), d = cGain(C, 0.5);
    src.connect(sp);
    sp.connect(a, 0); sp.connect(b, 1);
    sp.connect(cc, 0); sp.connect(d, 1);
    a.connect(mg, 0, 0); b.connect(mg, 0, 0);
    cc.connect(mg, 0, 1); d.connect(mg, 0, 1);
    var side = cGain(C, 1.15);
    mg.connect(side);
    var mL = cGain(C, 0.5), mR = cGain(C, 0.5);
    sp.connect(mL, 0); sp.connect(mR, 1);
    var bk = cFilter(C, "lowpass", 150), bg = cGain(C, 0.85);
    mL.connect(bk); mR.connect(bk); bk.connect(bg);
    var sum2 = cGain(C, 1);
    side.connect(sum2); bg.connect(sum2);
    return sum2;
  }

  function ensureCtx() {
    if (!AC) {
      setStatus("Sorry — your browser does not support Web Audio, so the player can't run here. The Android app works on any device.", true);
      return false;
    }
    if (!actx) {
      try { actx = new AC(); }
      catch (e) {
        setStatus("Could not start audio on this device (" + (e && e.message ? e.message : "unknown error") + ").", true);
        return false;
      }
      mix = actx.createGain();
      comp = actx.createDynamicsCompressor();
      comp.threshold.value = -8; comp.knee.value = 12; comp.ratio.value = 6;
      comp.attack.value = 0.004; comp.release.value = 0.18;
      eqIn = actx.createGain();
      var types = ["lowshelf", "peaking", "peaking", "peaking", "highshelf"];
      var freqs = [60, 230, 910, 3600, 14000];
      eqBands = [];
      var prev = eqIn;
      for (var i = 0; i < 5; i++) {
        var f = actx.createBiquadFilter();
        f.type = types[i]; f.frequency.value = freqs[i];
        f.Q.value = 1.0; f.gain.value = 0;
        prev.connect(f); prev = f;
        eqBands.push(f);
      }
      master = actx.createGain();
      analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      mix.connect(comp); comp.connect(eqIn);
      prev.connect(master);
      master.connect(analyser);
      analyser.connect(actx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      applyEQ();
      applyVolume();
    }
    if (actx.state === "suspended") actx.resume().catch(function () { /* ignore */ });
    return true;
  }

  function effStem(which) {
    var soloAny = soloV || soloI;
    if (which === "v") {
      if (muteV) return 0;
      if (soloAny && !soloV) return 0;
      if (mode === "karaoke") return 0;
      if (mode === "vocals") return 1;
      if (mode === "original") return 1;
      return stemV / 100;
    }
    if (muteI) return 0;
    if (soloAny && !soloI) return 0;
    if (mode === "vocals") return 0;
    if (mode === "karaoke") return 1;
    if (mode === "original") return 1;
    return stemI / 100;
  }

  function applyStemGains() {
    if (!actx) return;
    try {
      var t = actx.currentTime;
      if (graphV) graphV.gain.setTargetAtTime(effStem("v"), t, 0.03);
      if (graphI) graphI.gain.setTargetAtTime(effStem("i"), t, 0.03);
    } catch (e) {
      if (graphV) graphV.gain.value = effStem("v");
      if (graphI) graphI.gain.value = effStem("i");
    }
  }

  function applyVolume() {
    if (!actx || !master) return;
    var v = muted ? 0 : (volume / 100);
    try { master.gain.setTargetAtTime(v, actx.currentTime, 0.02); }
    catch (e) { master.gain.value = v; }
    if (muteBtn) { muteBtn.textContent = (muted || volume === 0) ? "🔇" : "🔊"; }
  }

  function currentPos() {
    if (!buffer) return 0;
    var pos = playing ? (offsetBase + (actx.currentTime - startCtxTime) * playbackRate) : offsetBase;
    if (pos < 0) pos = 0;
    if (pos > duration) pos = duration;
    return pos;
  }

  function stopSource() {
    if (source) {
      try { source.onended = null; } catch (e) { /* ignore */ }
      try { source.stop(0); } catch (e) { /* already stopped */ }
      try { source.disconnect(); } catch (e) { /* ignore */ }
      source = null;
    }
    if (graphV) { try { graphV.disconnect(); } catch (e) { /* ignore */ } graphV = null; }
    if (graphI) { try { graphI.disconnect(); } catch (e) { /* ignore */ } graphI = null; }
  }

  function startAt(offset) {
    if (!buffer || !actx) return;
    stopSource();
    offset = Math.max(0, Math.min(offset, Math.max(duration - 0.05, 0)));
    source = actx.createBufferSource();
    source.buffer = buffer;
    try { source.playbackRate.value = playbackRate; } catch (e) { /* ignore */ }
    var stereo = buffer.numberOfChannels >= 2;
    if (mode === "original") {
      source.connect(eqIn);
    } else {
      if (mode === "vocals" || mode === "custom") {
        var vOut = buildVocalChain(actx, source, stereo);
        graphV = actx.createGain();
        vOut.connect(graphV); graphV.connect(mix);
      }
      if (mode === "karaoke" || mode === "custom") {
        var iOut = buildInstChain(actx, source, stereo);
        graphI = actx.createGain();
        iOut.connect(graphI); graphI.connect(mix);
      }
      applyStemGains();
    }
    source.onended = function () {
      if (!playing) return;
      if (currentPos() >= duration - 0.25) onTrackEnded();
    };
    try { source.start(0, offset); }
    catch (e) {
      setStatus("Playback failed: " + (e && e.message ? e.message : "unknown error"), true);
      playing = false;
      setPlayIcon(false);
      return;
    }
    offsetBase = offset;
    startCtxTime = actx.currentTime;
    playing = true;
    setPlayIcon(true);
    if (demoStop) demoStop.disabled = false;
    startVizLoop();
  }

  function pausePlayback() {
    if (!playing) return;
    offsetBase = currentPos();
    playing = false;
    stopSource();
    setPlayIcon(false);
    updateProgressUI();
  }

  function stopPlayback() {
    offsetBase = 0;
    playing = false;
    stopSource();
    setPlayIcon(false);
    updateProgressUI();
    if (demoStop) demoStop.disabled = true;
  }

  function togglePlay() {
    if (!buffer) {
      var ids = currentViewIds.length ? currentViewIds.slice() : library.map(function (s) { return s.id; });
      if (!ids.length) { toast("Add songs first — drop files or generate the demo mix."); return; }
      playFromList(ids, 0);
      return;
    }
    if (!ensureCtx()) return;
    if (playing) pausePlayback();
    else startAt(currentPos() >= duration - 0.1 ? 0 : currentPos());
  }

  function updateProgressUI() {
    var pos = currentPos();
    var pct = duration > 0 ? (pos / duration) * 100 : 0;
    if (demoFill) demoFill.style.width = pct.toFixed(2) + "%";
    if (demoCur) demoCur.textContent = fmtTime(pos);
    if (demoTotal) demoTotal.textContent = fmtTime(duration);
    if (demoProg) demoProg.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  function seekTo(ratio) {
    if (!buffer || duration <= 0) return;
    ratio = Math.max(0, Math.min(1, ratio));
    var pos = ratio * duration;
    if (playing) startAt(pos);
    else { offsetBase = pos; updateProgressUI(); }
  }

  /* ---------- queue (up next) ---------- */
  var queue = [], qi = -1, shuffle = false, repeatMode = "off";

  function playFromList(ids, idx) {
    if (!ids || !ids.length) return;
    queue = ids.slice();
    qi = Math.max(0, Math.min(idx || 0, queue.length - 1));
    if (shuffle && queue.length > 1) {
      var cur = queue[qi];
      var rest = queue.slice(0, qi).concat(queue.slice(qi + 1));
      for (var i = rest.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = rest[i]; rest[i] = rest[j]; rest[j] = t;
      }
      queue = [cur].concat(rest);
      qi = 0;
    }
    loadSongById(queue[qi], true);
  }

  var loadToken = 0;
  function loadSongById(id, autoplay) {
    var song = songById(id);
    if (!song) return;
    if (!ensureCtx()) return;
    var my = ++loadToken;
    currentId = id;
    setStatus("Loading “" + song.title + "”…");
    markCurrentRow(); renderQueue(); updateMini(); updateFavUI();
    getBuffer(song).then(function (buf) {
      if (my !== loadToken) return;
      stopPlayback();
      buffer = buf;
      duration = buf.duration || 0;
      offsetBase = 0;
      if (song.duration !== duration) { song.duration = duration; idbPut(cleanRec(song)); }
      if (demoLabel) { demoLabel.textContent = song.title; demoLabel.title = song.title + " — " + song.artist; }
      if (npArtist) npArtist.textContent = song.artist + " · " + (buf.numberOfChannels >= 2 ? "stereo" : "mono");
      enableTransport(true);
      updateProgressUI(); drawViz();
      markCurrentRow(); renderQueue(); renderLibrary(); updateMini(); updateFavUI();
      setStatus("“" + song.title + "” (" + fmtTime(duration) + ", " + (buf.numberOfChannels >= 2 ? "stereo" : "mono") + ") — " + modeLabelLong() + (autoplay ? " — playing." : ". Press play to listen."));
      if (autoplay) startAt(0);
    }).catch(function () {
      if (my !== loadToken) return;
      setStatus("Could not play “" + song.title + "”. The file may be corrupt — try another song.", true);
    });
  }

  function decodeArrayBuffer(ab) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function ok(b) { if (!done) { done = true; resolve(b); } }
      function fail(e) { if (!done) { done = true; reject(e || new Error("decode")); } }
      try {
        var p = actx.decodeAudioData(ab, ok, fail);
        if (p && typeof p.then === "function") p.then(ok, fail);
      } catch (e) { fail(e); }
    });
  }

  function cacheBuffer(song, b) {
    for (var i = 0; i < library.length; i++) if (library[i] !== song) library[i]._buffer = null;
    song._buffer = b;
  }

  function getBuffer(song) {
    return new Promise(function (resolve, reject) {
      if (song._buffer) { resolve(song._buffer); return; }
      var blob = song.blob;
      if (!blob) { reject(new Error("no data")); return; }
      function onAb(ab) {
        decodeArrayBuffer(ab).then(function (b) { cacheBuffer(song, b); resolve(b); }, reject);
      }
      try {
        if (blob.arrayBuffer) blob.arrayBuffer().then(onAb, reject);
        else {
          var r = new FileReader();
          r.onload = function () { onAb(r.result); };
          r.onerror = function () { reject(new Error("read")); };
          r.readAsArrayBuffer(blob);
        }
      } catch (e) { reject(e); }
    });
  }

  function onTrackEnded() {
    if (repeatMode === "one") { startAt(0); return; }
    if (qi >= 0 && qi < queue.length - 1) { qi++; loadSongById(queue[qi], true); return; }
    if (repeatMode === "all" && queue.length) { qi = 0; loadSongById(queue[qi], true); return; }
    playing = false; offsetBase = 0;
    setPlayIcon(false); updateProgressUI();
    setStatus("Finished. Press play to hear it again, or pick another song.");
  }

  function stepNext() {
    if (!queue.length) { toast("Nothing in the queue — play a song first."); return; }
    qi = (qi + 1) % queue.length;
    loadSongById(queue[qi], true);
  }

  function stepPrev() {
    if (buffer && currentPos() > 3) { startAt(0); return; }
    if (!queue.length) { toast("Nothing in the queue — play a song first."); return; }
    qi = (qi - 1 + queue.length) % queue.length;
    loadSongById(queue[qi], true);
  }

  function renderQueue() {
    if (!queueList) return;
    queueList.innerHTML = "";
    if (queueCount) queueCount.textContent = queue.length ? "(" + queue.length + ")" : "";
    if (!queue.length) {
      var li0 = document.createElement("li");
      li0.className = "queue-empty";
      li0.textContent = "Queue is empty — tap any song to start playing.";
      queueList.appendChild(li0);
      return;
    }
    for (var k = 0; k < queue.length; k++) {
      (function (idx) {
        var s = songById(queue[idx]);
        if (!s) return;
        var li = document.createElement("li");
        li.className = "queue-row" + (idx === qi ? " is-current" : "") + (idx < qi ? " is-past" : "");
        var b = document.createElement("button");
        b.type = "button";
        b.className = "queue-main";
        b.setAttribute("aria-label", "Play " + s.title);
        var num = document.createElement("span");
        num.className = "queue-num";
        num.textContent = idx === qi ? "▶" : String(idx + 1);
        var meta = document.createElement("span");
        meta.className = "queue-meta";
        var t = document.createElement("strong");
        t.textContent = s.title;
        var a = document.createElement("span");
        a.textContent = s.artist + " · " + (s.duration > 0 ? fmtTime(s.duration) : "–:––");
        meta.appendChild(t); meta.appendChild(a);
        b.appendChild(num); b.appendChild(meta);
        b.addEventListener("click", function () { qi = idx; loadSongById(queue[qi], true); });
        li.appendChild(b);
        queueList.appendChild(li);
      })(k);
    }
  }

  /* ---------- splitter UI ---------- */
  var MODE_NAMES = { original: "Original mix", vocals: "🎤 Vocals only", karaoke: "🎶 Karaoke", custom: "🎚 My mix" };
  var MODE_ICONS = { original: "🎧", vocals: "🎤", karaoke: "🎶", custom: "🎚" };

  function isolationMethod() {
    var stereo = !!(buffer && buffer.numberOfChannels >= 2);
    if (mode === "original") return "original";
    if (mode === "vocals") return stereo ? "stereo-center" : "mono-focus";
    if (mode === "karaoke") return stereo ? "stereo-side-bass" : "mono-remove";
    return stereo ? "stereo-dual" : "mono-dual";
  }

  function modeLabelLong() {
    var methods = {
      original: "untouched audio",
      "stereo-center": "stereo center extraction — instruments removed, lyrics kept",
      "stereo-side-bass": "stereo side extraction + bass return",
      "stereo-dual": "dual-stem mix (vocals " + Math.round(effStem("v") * 100) + "% · music " + Math.round(effStem("i") * 100) + "%)",
      "mono-focus": "mono frequency focus (vocal band kept)",
      "mono-remove": "mono vocal-band removal",
      "mono-dual": "dual-stem mix (vocals " + Math.round(effStem("v") * 100) + "% · music " + Math.round(effStem("i") * 100) + "%)"
    };
    return "Mode: " + (MODE_NAMES[mode] || mode) + " · engine: " + (methods[isolationMethod()] || "isolation");
  }

  function updateModeStatus() {
    if (!buffer) return;
    setStatus(modeLabelLong() + (playing ? " — playing." : ". Press play to listen."));
  }

  function updateStemUI() {
    if (stemVocal) stemVocal.value = String(Math.round(stemV));
    if (stemInst) stemInst.value = String(Math.round(stemI));
    if (stemVocalVal) stemVocalVal.textContent = Math.round(stemV) + "%";
    if (stemInstVal) stemInstVal.textContent = Math.round(stemI) + "%";
    if (muteVocalBtn) muteVocalBtn.classList.toggle("is-off", muteV);
    if (muteInstBtn) muteInstBtn.classList.toggle("is-off", muteI);
    if (soloVocalBtn) soloVocalBtn.classList.toggle("is-off", soloV);
    if (soloInstBtn) soloInstBtn.classList.toggle("is-off", soloI);
    var cv = $("stem-card-vocal"), ci = $("stem-card-inst");
    if (cv) cv.classList.toggle("stem-muted", effStem("v") <= 0.001);
    if (ci) ci.classList.toggle("stem-muted", effStem("i") <= 0.001);
  }

  function setMode(m, opts) {
    opts = opts || {};
    if (["original", "vocals", "karaoke", "custom"].indexOf(m) < 0) m = "original";
    var changed = (m !== mode);
    if (mode === "custom" && m !== "custom") { customMem.v = stemV; customMem.i = stemI; }
    mode = m;
    if (m === "original") { stemV = 100; stemI = 100; }
    else if (m === "vocals") { stemV = 100; stemI = 0; }
    else if (m === "karaoke") { stemV = 0; stemI = 100; }
    else if (opts.fromButton) { stemV = customMem.v; stemI = customMem.i; }
    for (var k = 0; k < modeBtns.length; k++) {
      modeBtns[k].classList.toggle("is-active", modeBtns[k].getAttribute("data-mode") === m);
    }
    updateStemUI();
    updateMini();
    savePlayerSettings();
    if (buffer && playing && (changed || opts.rebuild)) startAt(currentPos());
    else if (buffer) applyStemGains();
    if (!opts.silent) updateModeStatus();
  }

  function ensureCustomMix() {
    if (mode !== "custom") setMode("custom", { silent: true });
  }

  /* ---------- WAV export ---------- */
  function encodeWAV(ab) {
    var numCh = Math.min(2, ab.numberOfChannels), sr = Math.floor(ab.sampleRate) || 44100, len = ab.length;
    var dataLen = len * numCh * 2;
    var buf = new ArrayBuffer(44 + dataLen), v = new DataView(buf), o = 0;
    function wstr(s) { for (var i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); }
    function u32(x) { v.setUint32(o, x, true); o += 4; }
    function u16(x) { v.setUint16(o, x, true); o += 2; }
    wstr("RIFF"); u32(36 + dataLen); wstr("WAVE"); wstr("fmt "); u32(16); u16(1); u16(numCh);
    u32(sr); u32(sr * numCh * 2); u16(numCh * 2); u16(16); wstr("data"); u32(dataLen);
    var chans = [];
    for (var c = 0; c < numCh; c++) chans.push(ab.getChannelData(c));
    for (var i = 0; i < len; i++) {
      for (var c2 = 0; c2 < numCh; c2++) {
        var s = Math.max(-1, Math.min(1, chans[c2][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2;
      }
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function downloadBlob(blob, filename) {
    var url = null;
    try { url = URL.createObjectURL(blob); } catch (e) { toast("Export failed in this browser.", "error"); return; }
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    try { a.click(); } catch (e) { /* ignore */ }
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (e) { /* ignore */ }
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }, 4000);
  }

  function setExporting(busy) {
    exporting = busy;
    var dis = busy || !buffer;
    if (exportVocalsBtn) exportVocalsBtn.disabled = dis;
    if (exportKaraokeBtn) exportKaraokeBtn.disabled = dis;
    if (exportMixBtn) exportMixBtn.disabled = dis;
  }

  function renderExport(kind) {
    var song = currentSong();
    if (!song || !buffer) { toast("Play a song first, then export your mix."); return; }
    if (exporting) return;
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) { toast("Export is not supported in this browser.", "error"); return; }
    if (!ensureCtx()) return;
    var sr = buffer.sampleRate || 44100;
    if (buffer.duration > 15 * 60) { toast("That song is over 15 minutes — export supports up to 15 minutes.", "error"); return; }
    var len = Math.max(1, Math.floor(buffer.duration * sr));
    var labels = { vocals: "vocals-only mix", karaoke: "karaoke mix", mix: "custom mix" };
    setStatus("Rendering " + (labels[kind] || "mix") + " for “" + song.title + "”… (takes a few seconds)");
    setExporting(true);
    var stereo = buffer.numberOfChannels >= 2;
    var oc;
    try { oc = new OC(2, len, sr); }
    catch (e) { setExporting(false); setStatus("Export failed: not enough memory for this song.", true); return; }
    var src = oc.createBufferSource();
    src.buffer = buffer;
    var out = oc.createGain();
    var pureOriginal = (kind === "mix" && mode === "original");
    if (pureOriginal) {
      src.connect(out);
    } else {
      var v = 1, i = 1;
      if (kind === "vocals") { v = 1; i = 0; }
      else if (kind === "karaoke") { v = 0; i = 1; }
      else { v = effStem("v"); i = effStem("i"); }
      if (v > 0) {
        var gv = oc.createGain(); gv.gain.value = v;
        buildVocalChain(oc, src, stereo).connect(gv); gv.connect(out);
      }
      if (i > 0) {
        var gi = oc.createGain(); gi.gain.value = i;
        buildInstChain(oc, src, stereo).connect(gi); gi.connect(out);
      }
      var cp = oc.createDynamicsCompressor();
      cp.threshold.value = -8; cp.knee.value = 12; cp.ratio.value = 6;
      cp.attack.value = 0.004; cp.release.value = 0.18;
      out.connect(cp); out = cp;
    }
    var tail = out;
    if (eqOn) {
      var types = ["lowshelf", "peaking", "peaking", "peaking", "highshelf"];
      var freqs = [60, 230, 910, 3600, 14000];
      for (var b = 0; b < 5; b++) {
        var bf = oc.createBiquadFilter();
        bf.type = types[b]; bf.frequency.value = freqs[b];
        bf.Q.value = 1.0; bf.gain.value = eqGains[b] || 0;
        tail.connect(bf); tail = bf;
      }
    }
    tail.connect(oc.destination);
    try { src.start(0); } catch (e) { /* ignore */ }
    oc.startRendering().then(function (rendered) {
      setExporting(false);
      var wav = encodeWAV(rendered);
      var safe = String(song.title || "mix").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "mix";
      var suffix = kind === "vocals" ? "vocals-only" : (kind === "karaoke" ? "karaoke" : "my-mix");
      downloadBlob(wav, safe + " (" + suffix + ").wav");
      setStatus("Exported “" + song.title + "” (" + suffix + ", WAV). Check your downloads.");
      toast("Export finished — check your downloads.", "success");
    }).catch(function () {
      setExporting(false);
      setStatus("Export failed in this browser — try a shorter song.", true);
    });
  }

  /* ---------- equalizer ---------- */
  var EQ_PRESETS = {
    normal: [0, 0, 0, 0, 0],
    pop: [-1, 2, 4, 2, -1],
    rock: [5, 3, -1, 3, 4],
    jazz: [3, 2, -1, 2, 3],
    classical: [4, 2, 0, 3, 5],
    dance: [6, 2, 0, 3, 5],
    bass: [8, 5, 1, 0, 0],
    vocal: [-2, -1, 2, 4, 3],
    treble: [0, 0, 1, 4, 7]
  };
  var eqGains = [0, 0, 0, 0, 0], eqOn = true, eqPresetName = "normal";

  function applyEQ() {
    if (!actx || !eqBands.length) return;
    for (var i = 0; i < 5; i++) {
      var g = eqOn ? (eqGains[i] || 0) : 0;
      try { eqBands[i].gain.setTargetAtTime(g, actx.currentTime, 0.02); }
      catch (e) { eqBands[i].gain.value = g; }
    }
  }
  function updateEqUI() {
    for (var i = 0; i < 5; i++) {
      if (eqBandEls[i]) eqBandEls[i].value = String(eqGains[i]);
      if (eqValEls[i]) eqValEls[i].textContent = (eqGains[i] > 0 ? "+" : "") + eqGains[i] + " dB";
    }
    if (eqPreset) eqPreset.value = EQ_PRESETS[eqPresetName] ? eqPresetName : "custom";
    if (eqEnabled) {
      eqEnabled.classList.toggle("is-on", eqOn);
      eqEnabled.setAttribute("aria-checked", eqOn ? "true" : "false");
    }
  }

  /* ---------- sleep timer ---------- */
  var sleepAt = 0;
  function updateSleepLabel() {
    if (!sleepLabel) return;
    if (!sleepAt) { sleepLabel.hidden = true; sleepLabel.textContent = ""; return; }
    var left = Math.max(0, sleepAt - Date.now());
    var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    sleepLabel.hidden = false;
    sleepLabel.textContent = "⏾ Sleep timer: playback stops in " + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function fadeAndPause() {
    if (!actx || !playing) { pausePlayback(); return; }
    try {
      master.gain.cancelScheduledValues(actx.currentTime);
      master.gain.setTargetAtTime(0.0001, actx.currentTime, 0.4);
    } catch (e) { /* ignore */ }
    setTimeout(function () { pausePlayback(); applyVolume(); }, 1600);
  }

  /* ---------- visualizer ---------- */
  var vizCtx = null;
  try { vizCtx = demoViz ? demoViz.getContext("2d") : null; } catch (e) { vizCtx = null; }
  var vizW = 0, vizH = 0;

  function sizeViz() {
    if (!demoViz || !vizCtx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    vizW = demoViz.clientWidth || 600;
    vizH = demoViz.clientHeight || 170;
    demoViz.width = Math.floor(vizW * dpr);
    demoViz.height = Math.floor(vizH * dpr);
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function refreshAccents() {
    try {
      var cs = getComputedStyle(document.documentElement);
      var a1 = cs.getPropertyValue("--accent-1").trim() || "#a855f7";
      var a3 = cs.getPropertyValue("--accent-3").trim() || "#22d3ee";
      accentCache = [a1, a3];
    } catch (e) { /* keep cache */ }
  }

  function drawIdleViz(t) {
    if (!vizCtx) return;
    vizCtx.clearRect(0, 0, vizW, vizH);
    vizCtx.beginPath();
    var mid = vizH / 2;
    for (var x = 0; x <= vizW; x += 4) {
      var y = mid + Math.sin(x * 0.02 + t / 500) * 12 * Math.sin(x * 0.005 + t / 900);
      if (x === 0) vizCtx.moveTo(x, y); else vizCtx.lineTo(x, y);
    }
    var g = vizCtx.createLinearGradient(0, 0, vizW, 0);
    g.addColorStop(0, accentCache[0]);
    g.addColorStop(1, accentCache[1]);
    vizCtx.strokeStyle = g;
    vizCtx.lineWidth = 2.5;
    vizCtx.globalAlpha = 0.7;
    vizCtx.stroke();
    vizCtx.globalAlpha = 1;
  }

  function drawViz() {
    if (!vizCtx) return;
    if (++accentTick % 30 === 0) refreshAccents();
    if (!analyser || !playing || !freqData) {
      drawIdleViz(performance.now());
      return;
    }
    analyser.getByteFrequencyData(freqData);
    vizCtx.clearRect(0, 0, vizW, vizH);
    var n = 48;
    var step = Math.floor(freqData.length / n) || 1;
    var bw = vizW / n;
    var g = vizCtx.createLinearGradient(0, vizH, 0, 0);
    g.addColorStop(0, accentCache[0]);
    g.addColorStop(1, accentCache[1]);
    vizCtx.fillStyle = g;
    for (var i = 0; i < n; i++) {
      var v = freqData[i * step] / 255;
      var h = Math.max(3, v * (vizH - 12));
      var x = i * bw + bw * 0.18;
      var w = bw * 0.64;
      var y = vizH - h;
      if (vizCtx.roundRect) {
        vizCtx.beginPath();
        vizCtx.roundRect(x, y, w, h, 3);
        vizCtx.fill();
      } else {
        vizCtx.fillRect(x, y, w, h);
      }
    }
  }

  function startVizLoop() {
    if (vizRaf || !vizCtx) return;
    var loop = function () {
      drawViz();
      updateProgressUI();
      if (playing) { vizRaf = requestAnimationFrame(loop); }
      else { vizRaf = null; drawViz(); }
    };
    vizRaf = requestAnimationFrame(loop);
  }

  function enableTransport(hasTrack) {
    if (demoPlay) demoPlay.disabled = !hasTrack;
    if (btnPrev) btnPrev.disabled = !hasTrack;
    if (btnNext) btnNext.disabled = !hasTrack;
    if (npFav) npFav.disabled = !hasTrack;
    for (var i = 0; i < modeBtns.length; i++) modeBtns[i].disabled = !hasTrack;
    var stems = [stemVocal, stemInst, muteVocalBtn, muteInstBtn, soloVocalBtn, soloInstBtn];
    for (var s = 0; s < stems.length; s++) if (stems[s]) stems[s].disabled = !hasTrack;
    setExporting(false);
    if (!hasTrack && demoStop) demoStop.disabled = true;
  }

  /* ---------- import ---------- */
  var MAX_FILE = 80 * 1024 * 1024;
  function looksAudio(f) {
    return (f.type && f.type.indexOf("audio") === 0) ||
      /\.(mp3|wav|m4a|aac|ogg|opus|flac|wma|oga|weba|webm)$/i.test(f.name || "");
  }
  function readAndDecode(f) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { decodeArrayBuffer(r.result).then(res, rej); };
      r.onerror = function () { rej(new Error("read")); };
      try { r.readAsArrayBuffer(f); } catch (e) { rej(e); }
    });
  }
  function loadFiles(files) {
    if (!files || !files.length) return;
    if (!ensureCtx()) return;
    var list = [];
    for (var i = 0; i < files.length; i++) list.push(files[i]);
    var ok = 0, bad = 0, big = 0, idx = 0;
    var newIds = [];
    function next() {
      if (idx >= list.length) {
        renderLibrary();
        if (ok) toast("Added " + ok + " song" + (ok === 1 ? "" : "s") + " to your library.", "success");
        if (bad) toast(bad + " file(s) were skipped (not audio or unreadable).", "error");
        if (big) toast(big + " file(s) exceeded 80 MB and were skipped.", "error");
        if (newIds.length && !currentId) playFromList(newIds, 0);
        else { markCurrentRow(); setStatus(library.length + " song(s) in your library. Tap any song to play it, then split it into vocals + music."); }
        return;
      }
      var f = list[idx++];
      if (!looksAudio(f)) { bad++; next(); return; }
      if (f.size > MAX_FILE) { big++; next(); return; }
      setStatus("Importing " + idx + "/" + list.length + ": “" + f.name + "”…");
      readAndDecode(f).then(function (buf) {
        var meta = parseName(f.name);
        var rec = {
          id: uid(), title: meta.title, artist: meta.artist, name: f.name,
          duration: buf ? buf.duration : 0, blob: f, favorite: false, dateAdded: Date.now()
        };
        library.push(rec);
        idbPut(cleanRec(rec));
        newIds.push(rec.id);
        ok++;
        next();
      }).catch(function () { bad++; next(); });
    }
    next();
  }

  /* ---- built-in synthesized demo mix (10 s, stereo) ----
     Center: vocal-like melody (kept by "Vocals only").
     Sides:  panned pads, riff + hats (kept by "Karaoke"). */
  function renderDemoMix() {
    if (!ensureCtx()) return;
    var sr = actx.sampleRate || 44100;
    var len = Math.floor(sr * 10);
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) {
      setStatus("Sorry — your browser can't render the demo mix. Please add audio files instead.", true);
      return;
    }
    setStatus("Rendering demo mix…");
    if (demoSynth) demoSynth.disabled = true;
    var off = new OC(2, len, sr);
    var out = off.createGain();
    out.gain.value = 0.9;
    out.connect(off.destination);

    function pan(node, v) {
      if (off.createStereoPanner) {
        var p = off.createStereoPanner();
        p.pan.value = v;
        node.connect(p); p.connect(out);
      } else {
        node.connect(out);
      }
    }

    var notes = [440, 523.25, 659.25, 587.33, 523.25, 440, 392, 440];
    var noteLen = 10 / notes.length;
    notes.forEach(function (f, i) {
      var t0 = i * noteLen;
      var o = off.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      var lfo = off.createOscillator();
      lfo.frequency.value = 5.5;
      var lfoG = off.createGain();
      lfoG.gain.value = f * 0.012;
      lfo.connect(lfoG); lfoG.connect(o.frequency);
      var harm = off.createOscillator();
      harm.type = "triangle";
      harm.frequency.value = f * 2;
      var harmG = off.createGain(); harmG.gain.value = 0.08;
      harm.connect(harmG); harmG.connect(out);
      var g = off.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.08);
      g.gain.setValueAtTime(0.5, t0 + noteLen - 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + noteLen);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + noteLen + 0.02);
      harm.start(t0); harm.stop(t0 + noteLen + 0.02);
      lfo.start(t0); lfo.stop(t0 + noteLen + 0.02);
    });

    var chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [261.63, 329.63, 392], [196, 246.94, 293.66]];
    chords.forEach(function (chord, ci) {
      var t0 = ci * 2.5;
      chord.forEach(function (f) {
        [-6, 6].forEach(function (cents, k) {
          var o = off.createOscillator();
          o.type = "sawtooth";
          o.frequency.value = f;
          o.detune.value = cents;
          var lp = off.createBiquadFilter();
          lp.type = "lowpass"; lp.frequency.value = 850;
          var g = off.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.4);
          g.gain.setValueAtTime(0.06, t0 + 2.1);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.5);
          o.connect(lp); lp.connect(g);
          pan(g, k === 0 ? -0.75 : 0.75);
          o.start(t0); o.stop(t0 + 2.55);
        });
      });
    });

    var riff = [329.63, 392, 523.25, 392, 440, 392, 329.63, 293.66];
    riff.forEach(function (f, i) {
      [0, 1, 2, 3].forEach(function (rep) {
        var t0 = rep * 2.5 + i * (2.5 / 8);
        var o = off.createOscillator();
        o.type = "square"; o.frequency.value = f;
        var g = off.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
        o.connect(g); pan(g, 0.7);
        o.start(t0); o.stop(t0 + 0.32);
      });
    });

    var noiseLen = Math.floor(sr * 0.05);
    var noiseBuf = off.createBuffer(1, noiseLen, sr);
    var nd = noiseBuf.getChannelData(0);
    for (var n = 0; n < noiseLen; n++) nd[n] = (Math.random() * 2 - 1) * (1 - n / noiseLen);
    for (var h = 0; h < 40; h++) {
      var t0 = h * 0.25;
      var src = off.createBufferSource();
      src.buffer = noiseBuf;
      var hp = off.createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = 6500;
      var hg = off.createGain(); hg.gain.value = h % 4 === 0 ? 0.25 : 0.14;
      src.connect(hp); hp.connect(hg);
      pan(hg, h % 2 === 0 ? -0.8 : 0.8);
      src.start(t0);
    }

    var roots = [110, 87.31, 130.81, 98];
    roots.forEach(function (f, i) {
      var t0 = i * 2.5;
      var o = off.createOscillator();
      o.type = "sine"; o.frequency.value = f;
      var g = off.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.15);
      g.gain.setValueAtTime(0.12, t0 + 2.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.5);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + 2.55);
    });

    off.startRendering().then(function (buf) {
      if (demoSynth) demoSynth.disabled = false;
      var wav = encodeWAV(buf);
      var file = wav;
      try { file = new File([wav], "Neon Skyline (demo mix).wav", { type: "audio/wav" }); }
      catch (e) { /* keep plain blob */ }
      var rec = {
        id: uid(), title: "Neon Skyline", artist: "VocalPure Demo",
        name: "Neon Skyline (demo mix).wav", duration: buf.duration,
        blob: file, favorite: false, dateAdded: Date.now()
      };
      library.push(rec);
      idbPut(cleanRec(rec));
      renderLibrary();
      playFromList([rec.id], 0);
      setStatus("Playing the built-in demo mix. Split it: 🎤 Vocals only keeps the center melody, 🎶 Karaoke keeps the band.");
    }).catch(function () {
      if (demoSynth) demoSynth.disabled = false;
      setStatus("Demo rendering failed in this browser — please add an audio file instead.", true);
    });
  }

  /* ---------- mini player ---------- */
  function updateMini() {
    var s = currentSong();
    if (!miniBar) return;
    miniBar.hidden = !s;
    document.body.classList.toggle("mini-on", !!s);
    if (!s) return;
    if (miniTitle) miniTitle.textContent = s.title;
    if (miniSub) miniSub.textContent = s.artist + " · " + (MODE_NAMES[mode] || mode);
    if (miniPlay) miniPlay.textContent = playing ? "⏸" : "▶";
    if (miniSplit) {
      miniSplit.textContent = MODE_ICONS[mode] || "🎧";
      miniSplit.title = "Split: " + (MODE_NAMES[mode] || mode) + " (tap to change)";
    }
  }
  function cycleMode() {
    if (!buffer) { toast("Play a song first to switch split modes."); return; }
    var order = ["original", "vocals", "karaoke", "custom"];
    setMode(order[(order.indexOf(mode) + 1) % order.length], { fromButton: true });
  }

  /* ---------- shuffle / repeat UI ---------- */
  function updateShuffleRepeatUI() {
    if (btnShuffle) {
      btnShuffle.classList.toggle("is-active", shuffle);
      btnShuffle.title = "Shuffle: " + (shuffle ? "on" : "off");
      btnShuffle.setAttribute("aria-pressed", shuffle ? "true" : "false");
    }
    if (btnRepeat) {
      btnRepeat.classList.toggle("is-active", repeatMode !== "off");
      btnRepeat.textContent = repeatMode === "one" ? "🔂" : "🔁";
      btnRepeat.title = "Repeat: " + repeatMode;
    }
  }

  /* ============================================================
     Events
     ============================================================ */
  function openFilePicker() { if (demoFile) demoFile.click(); }
  on(demoBrowse, "click", openFilePicker);
  on(addSongsBtn, "click", openFilePicker);
  on(demoFile, "change", function () {
    if (demoFile.files && demoFile.files.length) loadFiles(demoFile.files);
    demoFile.value = "";
  });
  if (demoDrop) {
    ["dragenter", "dragover"].forEach(function (ev) {
      demoDrop.addEventListener(ev, function (e) {
        e.preventDefault();
        demoDrop.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      demoDrop.addEventListener(ev, function (e) {
        e.preventDefault();
        demoDrop.classList.remove("dragover");
      });
    });
    demoDrop.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    });
  }
  on(demoSynth, "click", renderDemoMix);

  on(demoPlay, "click", togglePlay);
  on(miniPlay, "click", togglePlay);
  on(demoStop, "click", stopPlayback);
  on(btnNext, "click", stepNext);
  on(miniNext, "click", stepNext);
  on(btnPrev, "click", stepPrev);
  on(miniSplit, "click", cycleMode);
  on(miniInfo, "click", function () {
    var app = $("player-app");
    if (app && app.scrollIntoView) app.scrollIntoView({ behavior: "smooth", block: "start" });
    else window.location.hash = "#demo";
  });
  on(btnShuffle, "click", function () {
    shuffle = !shuffle;
    if (shuffle && queue.length > 1 && qi >= 0) {
      var cur = queue[qi];
      var rest = queue.slice(0, qi).concat(queue.slice(qi + 1));
      for (var i = rest.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = rest[i]; rest[i] = rest[j]; rest[j] = t;
      }
      queue = [cur].concat(rest);
      qi = 0;
      renderQueue();
    }
    updateShuffleRepeatUI();
    savePlayerSettings();
    toast("Shuffle " + (shuffle ? "on." : "off."));
  });
  on(btnRepeat, "click", function () {
    repeatMode = repeatMode === "off" ? "all" : (repeatMode === "all" ? "one" : "off");
    updateShuffleRepeatUI();
    savePlayerSettings();
    toast("Repeat: " + repeatMode + ".");
  });

  on(demoVol, "input", function () {
    volume = Number(demoVol.value) || 0;
    if (volume > 0 && muted) { muted = false; }
    applyVolume();
    savePlayerSettings();
  });
  on(muteBtn, "click", function () {
    muted = !muted;
    applyVolume();
  });
  on(rateSel, "change", function () {
    var r = Number(rateSel.value) || 1;
    if (playing && buffer) { offsetBase = currentPos(); startCtxTime = actx.currentTime; }
    playbackRate = r;
    if (source) {
      try { source.playbackRate.setTargetAtTime(r, actx.currentTime, 0.02); }
      catch (e) { try { source.playbackRate.value = r; } catch (e2) { /* ignore */ } }
    }
    savePlayerSettings();
  });
  on(sleepSel, "change", function () {
    var mins = Number(sleepSel.value) || 0;
    if (mins > 0) {
      sleepAt = Date.now() + mins * 60000;
      toast("Sleep timer set: playback stops in " + mins + " min.", "success");
    } else {
      sleepAt = 0;
      toast("Sleep timer off.");
    }
    updateSleepLabel();
  });

  for (var m = 0; m < modeBtns.length; m++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var newMode = btn.getAttribute("data-mode");
        if (newMode === mode) return;
        if (!buffer) { toast("Add songs and play one first to compare split modes."); return; }
        setMode(newMode, { fromButton: true });
      });
    })(modeBtns[m]);
  }

  on(stemVocal, "input", function () {
    stemV = Number(stemVocal.value) || 0;
    ensureCustomMix();
    updateStemUI(); applyStemGains(); updateModeStatus();
    savePlayerSettings();
  });
  on(stemInst, "input", function () {
    stemI = Number(stemInst.value) || 0;
    ensureCustomMix();
    updateStemUI(); applyStemGains(); updateModeStatus();
    savePlayerSettings();
  });
  on(muteVocalBtn, "click", function () {
    muteV = !muteV;
    ensureCustomMix();
    updateStemUI(); applyStemGains(); updateModeStatus();
  });
  on(muteInstBtn, "click", function () {
    muteI = !muteI;
    ensureCustomMix();
    updateStemUI(); applyStemGains(); updateModeStatus();
  });
  on(soloVocalBtn, "click", function () {
    soloV = !soloV;
    ensureCustomMix();
    updateStemUI(); applyStemGains(); updateModeStatus();
  });
  on(soloInstBtn, "click", function () {
    soloI = !soloI;
    ensureCustomMix();
    updateStemUI(); applyStemGains(); updateModeStatus();
  });

  on(exportVocalsBtn, "click", function () { renderExport("vocals"); });
  on(exportKaraokeBtn, "click", function () { renderExport("karaoke"); });
  on(exportMixBtn, "click", function () { renderExport("mix"); });

  /* ---- equalizer events ---- */
  for (var eb = 0; eb < eqBandEls.length; eb++) {
    (function (idx) {
      on(eqBandEls[idx], "input", function () {
        eqGains[idx] = Number(eqBandEls[idx].value) || 0;
        eqPresetName = "custom";
        updateEqUI(); applyEQ(); savePlayerSettings();
      });
    })(eb);
  }
  on(eqPreset, "change", function () {
    var name = eqPreset.value;
    if (EQ_PRESETS[name]) {
      eqPresetName = name;
      eqGains = EQ_PRESETS[name].slice();
      updateEqUI(); applyEQ(); savePlayerSettings();
    }
  });
  on(eqReset, "click", function () {
    eqPresetName = "normal";
    eqGains = [0, 0, 0, 0, 0];
    eqOn = true;
    updateEqUI(); applyEQ(); savePlayerSettings();
    toast("Equalizer reset.");
  });
  on(eqEnabled, "click", function () {
    eqOn = !eqOn;
    updateEqUI(); applyEQ(); savePlayerSettings();
  });

  /* ---- library events ---- */
  for (var lt = 0; lt < libTabBtns.length; lt++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        libTab = btn.getAttribute("data-libtab") || "songs";
        for (var k = 0; k < libTabBtns.length; k++) {
          var active = libTabBtns[k] === btn;
          libTabBtns[k].classList.toggle("is-active", active);
          libTabBtns[k].setAttribute("aria-selected", active ? "true" : "false");
        }
        closePlPop();
        renderLibrary();
        if (libTab === "playlists") renderPlaylists();
      });
    })(libTabBtns[lt]);
  }
  on(songSearch, "input", function () {
    searchQuery = (songSearch.value || "").trim();
    renderLibrary();
  });
  on(songSort, "change", function () {
    sortKey = songSort.value || "added";
    renderLibrary();
  });
  if (songList) {
    songList.addEventListener("click", function (e) {
      var li = e.target.closest ? e.target.closest("li.song-row") : null;
      if (!li) return;
      var id = li.getAttribute("data-id");
      var btn = e.target.closest ? e.target.closest("button") : null;
      if (btn) {
        if (btn.classList.contains("fav-btn")) { toggleFav(id); return; }
        if (btn.classList.contains("add-btn")) {
          if (plPop && !plPop.hidden && plPopSongId === id) closePlPop();
          else openPlPop(id, btn);
          return;
        }
        if (btn.classList.contains("del-btn")) { removeSong(id); return; }
      }
      var at = currentViewIds.indexOf(id);
      playFromList(currentViewIds.slice(), at >= 0 ? at : 0);
    });
  }
  function createPlaylist() {
    var name = newPlaylistName ? (newPlaylistName.value || "").trim() : "";
    if (!name) name = "Playlist " + (playlists.length + 1);
    playlists.push({ id: uid(), name: name.slice(0, 40), songIds: [] });
    savePlaylists();
    renderPlaylists(); renderPlPop();
    if (newPlaylistName) newPlaylistName.value = "";
    toast("Playlist “" + name.slice(0, 40) + "” created. Tap ＋ on songs to fill it.", "success");
  }
  on(newPlaylistAdd, "click", createPlaylist);
  on(newPlaylistName, "keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); createPlaylist(); }
  });
  document.addEventListener("click", function (e) {
    if (!plPop || plPop.hidden) return;
    if (plPop.contains(e.target)) return;
    if (e.target.closest && e.target.closest(".add-btn")) return;
    closePlPop();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && plPop && !plPop.hidden) closePlPop();
  });
  on(npFav, "click", function () { if (currentId) toggleFav(currentId); });

  /* ---- now-playing tabs ---- */
  for (var pt = 0; pt < npTabBtns.length; pt++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var tab = btn.getAttribute("data-ptab");
        for (var k = 0; k < npTabBtns.length; k++) {
          var active = npTabBtns[k] === btn;
          npTabBtns[k].classList.toggle("is-active", active);
          npTabBtns[k].setAttribute("aria-selected", active ? "true" : "false");
        }
        if (ptabSplit) ptabSplit.hidden = (tab !== "split");
        if (ptabEq) ptabEq.hidden = (tab !== "eq");
        if (ptabQueue) ptabQueue.hidden = (tab !== "queue");
      });
    })(npTabBtns[pt]);
  }
  on(queueClear, "click", function () {
    queue = []; qi = -1;
    renderQueue();
    toast("Up-next cleared.");
  });

  /* ---- seek ---- */
  if (demoProg) {
    demoProg.addEventListener("click", function (e) {
      var rect = demoProg.getBoundingClientRect();
      if (rect.width <= 0) return;
      seekTo((e.clientX - rect.left) / rect.width);
    });
    demoProg.addEventListener("keydown", function (e) {
      if (!buffer || duration <= 0) return;
      if (e.key === "ArrowRight") { e.preventDefault(); seekTo((currentPos() + 5) / duration); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seekTo((currentPos() - 5) / duration); }
      else if (e.key === "Home") { e.preventDefault(); seekTo(0); }
      else if (e.key === "End") { e.preventDefault(); seekTo(1); }
    });
  }

  /* ============================================================
     Init
     ============================================================ */
  function initPlayer() {
    loadPlayerSettings();
    volume = playerSettings.volume;
    playbackRate = playerSettings.rate || 1;
    stemV = playerSettings.stemV; stemI = playerSettings.stemI;
    customMem.v = playerSettings.customV; customMem.i = playerSettings.customI;
    eqGains = playerSettings.eq.slice(); eqOn = !!playerSettings.eqOn;
    eqPresetName = playerSettings.eqPreset || "normal";
    shuffle = !!playerSettings.shuffle; repeatMode = playerSettings.repeat || "off";

    if (demoVol) demoVol.value = String(volume);
    if (rateSel) rateSel.value = String(playbackRate);
    updateEqUI();
    updateShuffleRepeatUI();

    loadPlaylists();
    renderLibrary();
    renderPlaylists();
    renderQueue();
    enableTransport(false);
    setMode(playerSettings.mode || "original", { silent: true });
    updateFavUI();
    updateMini();

    idbAll().then(function (recs) {
      library = (recs || []).map(function (r) {
        return {
          id: r.id, title: r.title || "Unknown", artist: r.artist || "Unknown artist",
          name: r.name || r.title || "Unknown", duration: r.duration || 0,
          blob: r.blob || null, favorite: !!r.favorite, dateAdded: r.dateAdded || 0, _buffer: null
        };
      }).filter(function (r) { return r.id; });
      renderLibrary();
      renderPlaylists();
      if (library.length && !currentId) {
        setStatus(library.length + " song(s) restored from your library. Tap any song to play it, then split it into vocals + music.");
      }
    }).catch(function () {
      idbFailed = true;
    });

    sizeViz();
    refreshAccents();
    drawIdleViz(0);
    updateProgressUI();
    window.addEventListener("resize", sizeViz);
    (function idle() {
      if (!playing) drawIdleViz(performance.now());
      requestAnimationFrame(idle);
    })();
    setInterval(function () {
      if (sleepAt && Date.now() >= sleepAt) {
        sleepAt = 0;
        if (sleepSel) sleepSel.value = "0";
        updateSleepLabel();
        fadeAndPause();
        toast("Sleep timer — playback stopped.");
      } else if (sleepAt) {
        updateSleepLabel();
      }
    }, 1000);
    if (!AC) {
      setStatus("Your browser does not support Web Audio, so the player is unavailable here. The Android app works on any device.", true);
      if (demoSynth) demoSynth.disabled = true;
    }
  }
  if (demoViz) initPlayer();
})();
