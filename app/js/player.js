/* ============================================================
   VocalPure — standalone music player app
   ------------------------------------------------------------
   Full player engine: library (songs / artists / playlists /
   favorites), search & sort, queue, shuffle & repeat, seek,
   volume, playback speed, sleep timer, 5-band EQ, two-stem
   vocal/music mixer with adjustable isolation, WAV export and
   Android integration (file picker, keep-screen-on, saving
   exports to device storage) via the VocalPureAndroid bridge.
   ============================================================ */
(function () {
  "use strict";

  /* ================= tiny DOM utils ================= */
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var toastBox = $("toasts");
  function toast(msg, isErr) {
    if (!toastBox) return;
    var t = document.createElement("div");
    t.className = "toast" + (isErr ? " err" : "");
    t.textContent = msg;
    toastBox.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .4s";
      t.style.opacity = "0";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 450);
    }, 2600);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.round(s);
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }
  function uid() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return ((h % 360) + 360) % 360;
  }
  function artStyle(el, seed) {
    var h = hashHue(seed || "vp");
    el.style.background =
      "linear-gradient(135deg, hsl(" + h + ", 65%, 52%), hsl(" + ((h + 55) % 360) + ", 70%, 42%))";
    return h;
  }
  function coverLetter(s) { return (String(s || "?").trim()[0] || "♪").toUpperCase(); }

  var MODE_NAMES = { original: "Original", vocals: "Vocals only", karaoke: "Karaoke", custom: "My mix" };
  var MODE_ICONS = { original: "🎧", vocals: "🎤", karaoke: "🎶", custom: "🎚" };
  var ICON_PLAY = "M7 4.5v15l13-7.5z";
  var ICON_PAUSE = "M6 4h4v16H6zM14 4h4v16h-4z";

  /* ================= bridge (Android) ================= */
  function bridge() { return window.VocalPureAndroid || null; }
  function bridgeInfo() {
    var b = bridge();
    if (b && typeof b.appInfo === "function") {
      try { return JSON.parse(b.appInfo()) || {}; } catch (e) { return {}; }
    }
    return {};
  }

  /* ================= persistent settings ================= */
  var SETTINGS_KEY = "vp3-settings";
  var settings = {
    volume: 85, rate: 1, mode: "original",
    stemV: 100, stemI: 100, customV: 70, customI: 70,
    eq: [0, 0, 0, 0, 0], eqOn: true, eqPreset: "flat",
    shuffle: false, repeat: "off",
    strength: 90, keepScreen: false
  };
  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        for (var k in settings) if (s && s.hasOwnProperty(k)) settings[k] = s[k];
      }
    } catch (e) { /* private mode etc. */ }
    if (!(settings.repeat === "off" || settings.repeat === "all" || settings.repeat === "one")) settings.repeat = "off";
    if (["original", "vocals", "karaoke", "custom"].indexOf(settings.mode) < 0) settings.mode = "original";
    if (settings.eq && settings.eq.length === 5) {
      settings.eq = settings.eq.map(function (v) { return Math.max(-12, Math.min(12, Number(v) || 0)); });
    } else settings.eq = [0, 0, 0, 0, 0];
    settings.volume = Math.max(0, Math.min(100, Number(settings.volume) || 0));
    settings.strength = Math.max(0, Math.min(100, Number(settings.strength) || 0));
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* ================= IndexedDB (songs + playlists) ================= */
  var DB_NAME = "vocalpure-v3", STORE_SONGS = "songs", STORE_PL = "playlists";
  var idb = null, idbFailed = false;
  function idbOpen() {
    if (idb) return Promise.resolve(idb);
    if (idbFailed || !window.indexedDB) return Promise.reject(new Error("no idb"));
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_SONGS)) db.createObjectStore(STORE_SONGS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_PL)) db.createObjectStore(STORE_PL, { keyPath: "id" });
      };
      req.onsuccess = function () { idb = req.result; res(idb); };
      req.onerror = function () { idbFailed = true; rej(req.error || new Error("idb open")); };
      req.onblocked = function () { rej(new Error("idb blocked")); };
    });
  }
  function idbAll(store) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var rq = db.transaction(store, "readonly").objectStore(store).getAll();
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { rej(rq.error || new Error("idb read")); };
      });
    });
  }
  function idbPut(store, rec) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(rec);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error || new Error("idb write")); };
      });
    }).catch(function () { /* quota errors are non-fatal */ });
  }
  function idbDel(store, id) {
    return idbOpen().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(id);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
      });
    }).catch(function () { });
  }
  function idbClear(store) {
    return idbOpen().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).clear();
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
      });
    }).catch(function () { });
  }

  /* ================= app state ================= */
  var library = [];            // [{id,title,artist,name,duration,favorite,dateAdded,blob}]
  var playlists = [];          // [{id,name,songIds[]}]
  var queue = [];              // up-next song ids (played before context resumes)
  var contextIds = [];         // ids of the list playback started from
  var contextPos = -1;

  var currentId = null;
  var playing = false;
  var buffer = null;           // decoded AudioBuffer of current song
  var stereo = false;
  var duration = 0;
  var offsetBase = 0, startCtxTime = 0;
  var stopIntent = false;

  var libTab = "songs";        // songs | artists | playlists | favorites
  var sortKey = "recent";
  var searchText = "";
  var artistFilter = "";       // "" = all artists

  var muted = false;
  var sleepAt = 0;             // timestamp
  var sleepEndOfTrack = false;
  var shuffleOrder = null;     // persisted order when shuffle on

  var muteV = false, muteI = false, soloV = false, soloI = false;
  var exporting = false;

  var bufferCache = [];        // [{id, buffer}] small LRU
  function cacheBuffer(id, buf) {
    for (var i = 0; i < bufferCache.length; i++) if (bufferCache[i].id === id) return;
    bufferCache.push({ id: id, buffer: buf });
    while (bufferCache.length > 5) bufferCache.shift();
  }
  function cachedBuffer(id) {
    for (var i = 0; i < bufferCache.length; i++) if (bufferCache[i].id === id) return bufferCache[i].buffer;
    return null;
  }

  function songById(id) {
    for (var i = 0; i < library.length; i++) if (library[i].id === id) return library[i];
    return null;
  }
  function currentSong() { return currentId ? songById(currentId) : null; }

  /* ================= audio engine ================= */
  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null, mix = null, comp = null, master = null, analyser = null, freqData = null;
  var eqBands = [];
  var stems = null;            // current VPIsolator graph
  var graphV = null, graphI = null;   // per-stem gain (mode / mute / solo / levels)
  var analyserV = null, analyserM = null, meterDataV = null, meterDataM = null;
  var source = null;

  function ensureCtx() {
    if (!AC) {
      toast("This device does not support Web Audio — playback is unavailable.", true);
      return false;
    }
    if (!actx) {
      try { actx = new AC(); } catch (e) { toast("Could not start audio (" + (e && e.message) + ")", true); return false; }
      mix = actx.createGain();
      comp = actx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 12; comp.ratio.value = 5;
      comp.attack.value = 0.004; comp.release.value = 0.2;

      var types = ["lowshelf", "peaking", "peaking", "peaking", "highshelf"];
      var freqs = [60, 230, 910, 3600, 14000];
      var prev = comp;
      eqBands = [];
      for (var i = 0; i < 5; i++) {
        var f = actx.createBiquadFilter();
        f.type = types[i]; f.frequency.value = freqs[i]; f.Q.value = 1.0; f.gain.value = 0;
        prev.connect(f); prev = f;
        eqBands.push(f);
      }
      master = actx.createGain();
      analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;

      prev.connect(master);
      master.connect(analyser);
      analyser.connect(actx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);

      analyserV = actx.createAnalyser(); analyserV.fftSize = 512; meterDataV = new Uint8Array(analyserV.fftSize);
      analyserM = actx.createAnalyser(); analyserM.fftSize = 512; meterDataM = new Uint8Array(analyserM.fftSize);

      applyEQ();
      applyVolume();
    }
    if (actx.state === "suspended") actx.resume().catch(function () { });
    return true;
  }

  function effStem(which) {
    var soloAny = soloV || soloI;
    if (which === "v") {
      if (muteV) return 0;
      if (soloAny && !soloV) return 0;
      if (mode() === "karaoke") return 0;
      if (mode() === "vocals" || mode() === "original") return 1;
      return settings.stemV / 100;
    }
    if (muteI) return 0;
    if (soloAny && !soloI) return 0;
    if (mode() === "vocals") return 0;
    if (mode() === "karaoke" || mode() === "original") return 1;
    return settings.stemI / 100;
  }
  function mode() { return settings.mode; }

  function applyStemGains() {
    if (!actx || !graphV) return;
    try {
      var t = actx.currentTime;
      graphV.gain.setTargetAtTime(effStem("v"), t, 0.03);
      graphI.gain.setTargetAtTime(effStem("i"), t, 0.03);
    } catch (e) {
      graphV.gain.value = effStem("v");
      graphI.gain.value = effStem("i");
    }
  }

  function applyVolume() {
    if (!actx || !master) return;
    var v = muted ? 0 : settings.volume / 100;
    try { master.gain.setTargetAtTime(v, actx.currentTime, 0.02); }
    catch (e) { master.gain.value = v; }
    var mb = $("mute-btn");
    if (mb) mb.textContent = (muted || settings.volume === 0) ? "🔇" : "🔊";
  }

  function applyEQ() {
    if (!eqBands.length) return;
    for (var i = 0; i < 5; i++) {
      var g = settings.eqOn ? (settings.eq[i] || 0) : 0;
      try { eqBands[i].gain.setTargetAtTime(g, actx.currentTime, 0.02); }
      catch (e) { eqBands[i].gain.value = g; }
    }
  }

  function currentPos() {
    if (!buffer) return 0;
    var pos = playing ? offsetBase + (actx.currentTime - startCtxTime) * settings.rate : offsetBase;
    if (pos < 0) pos = 0;
    if (pos > duration) pos = duration;
    return pos;
  }

  function stopSource() {
    if (source) {
      stopIntent = true;
      try { source.stop(0); } catch (e) { /* already stopped */ }
      try { source.disconnect(); } catch (e) { }
      source = null;
    }
  }

  function startAt(offset) {
    if (!buffer || !actx) return;
    stopSource();
    source = actx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = settings.rate;

    /* --- the two-stem separation graph (improved engine) --- */
    if (stems) {
      try { stems.vocal.disconnect(); stems.music.disconnect(); } catch (e) { }
    }
    stems = VPIsolator.buildStems(actx, source, stereo, { strength: settings.strength / 100 });
    graphV = actx.createGain();
    graphI = actx.createGain();
    stems.vocal.connect(graphV);
    stems.music.connect(graphI);
    graphV.connect(analyserV);
    graphI.connect(analyserM);
    analyserV.connect(mix);
    analyserM.connect(mix);
    applyStemGains();

    source.onended = function () {
      if (stopIntent) { stopIntent = false; return; }
      onTrackEnded();
    };
    offsetBase = Math.max(0, Math.min(offset || 0, duration - 0.02));
    startCtxTime = actx.currentTime;
    source.start(0, offsetBase);
    playing = true;
    updatePlayIcons();
    updateMediaSession();
  }

  function pausePlayback() {
    if (!playing) return;
    offsetBase = currentPos();
    stopSource();
    playing = false;
    updatePlayIcons();
  }

  function stopPlayback() {
    stopSource();
    playing = false;
    offsetBase = 0;
    updatePlayIcons();
    updateProgressUI();
  }

  function togglePlay() {
    if (!buffer) {
      if (library.length) { playFromContext(visibleSongIds(), 0); return; }
      toast("Import music first — tap the ＋ button.");
      return;
    }
    if (playing) pausePlayback();
    else { ensureCtx() && startAt(offsetBase); }
  }

  /* ---------- queue / context / navigation ---------- */
  function shuffled(ids) {
    var a = ids.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function activeOrder() {
    if (settings.shuffle && contextIds.length) {
      if (!shuffleOrder || shuffleOrder.src !== contextIds.join("|") + "::" + currentId) {
        var rest = contextIds.filter(function (id) { return id !== currentId; });
        shuffleOrder = { src: contextIds.join("|") + "::" + currentId, ids: (currentId ? [currentId] : []).concat(shuffled(rest)) };
      }
      return shuffleOrder.ids;
    }
    shuffleOrder = null;
    return contextIds;
  }
  function playFromContext(ids, startIndex, opts) {
    contextIds = (ids || []).slice();
    contextPos = Math.max(0, startIndex || 0);
    if (contextPos >= contextIds.length) contextPos = 0;
    loadSongById(contextIds[contextPos], !(opts && opts.noAutoplay));
  }
  function stepNext(user) {
    var order = activeOrder();
    if (!order.length) { stopPlayback(); return; }
    var idx = order.indexOf(currentId);
    if (idx < 0) idx = -1; // playing an out-of-list item (queue) → continue from the top
    if (settings.repeat === "one" && !user) {
      startAt(0); return;
    }
    var nextId = null;
    if (idx + 1 < order.length) nextId = order[idx + 1];
    else if (settings.repeat === "all") nextId = order[0];
    if (!nextId) {
      if (user) { /* wrap anyway on manual skip */ nextId = order[0]; }
      else { stopPlayback(); return; }
    }
    contextPos = contextIds.indexOf(nextId);
    loadSongById(nextId, true);
  }
  function stepPrev() {
    if (!buffer) return;
    if (currentPos() > 4) { startAt(0); return; }
    var order = activeOrder();
    var idx = order.indexOf(currentId);
    var prevId = idx > 0 ? order[idx - 1] : order[order.length - 1];
    if (!prevId) prevId = currentId;
    contextPos = contextIds.indexOf(prevId);
    loadSongById(prevId, true);
  }
  function onTrackEnded() {
    playing = false;
    if (sleepEndOfTrack) {
      sleepEndOfTrack = false;
      var sel = $("sleep-timer"); if (sel) sel.value = "0";
      updateSleepLabel();
      stopPlayback();
      toast("Sleep timer — stopped after this track.");
      return;
    }
    if (queue.length) {
      var id = queue.shift();
      renderQueue();
      loadSongById(id, true);
      return;
    }
    stepNext(false);
  }

  /* ---------- loading songs ---------- */
  function decodeArrayBuffer(ab) {
    return new Promise(function (resolve, reject) {
      if (!ensureCtx()) { reject(new Error("no audio ctx")); return; }
      var done = false;
      function ok(b) { if (!done) { done = true; resolve(b); } }
      function fail(e) { if (!done) { done = true; reject(e || new Error("decode")); } }
      var p = actx.decodeAudioData(ab, ok, fail);
      if (p && typeof p.then === "function") p.then(ok, fail);
    });
  }
  function getBuffer(song) {
    var cached = cachedBuffer(song.id);
    if (cached) return Promise.resolve(cached);
    return new Promise(function (resolve, reject) {
      if (!song.blob) { reject(new Error("missing audio data")); return; }
      var r = new FileReader();
      r.onload = function () {
        decodeArrayBuffer(r.result).then(function (b) {
          cacheBuffer(song.id, b);
          resolve(b);
        }, reject);
      };
      r.onerror = function () { reject(new Error("read")); };
      r.readAsArrayBuffer(song.blob);
    });
  }
  function loadSongById(id, autoplay) {
    var song = songById(id);
    if (!song) { toast("Song is no longer in your library.", true); return; }
    currentId = id;
    updateNowPlayingUI();
    updateMini();
    var np = $("nowplaying");
    if (autoplay && np && np.hidden) openNowPlaying();
    getBuffer(song).then(function (buf) {
      if (currentId !== id) return;
      buffer = buf;
      duration = buf.duration;
      stereo = VPIsolator.analyzeStereo(buf);
      offsetBase = 0;
      updateNowPlayingUI();
      updateSplitMethod();
      if (autoplay && ensureCtx()) startAt(0);
      else updateProgressUI();
    }).catch(function () {
      toast("Could not play “" + song.title + "” — the file may be damaged.", true);
    });
  }

  /* ---------- import ---------- */
  function looksAudio(f) {
    if (!f) return false;
    if (f.type && f.type.indexOf("audio/") === 0) return true;
    if (f.type && f.type.indexOf("video/") === 0) return true; // m4a often reports as video
    return /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|weba|mp4|aiff?|wma)$/i.test(f.name || "");
  }
  function parseName(fileName) {
    var base = String(fileName || "Unknown song").replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
    var m = base.match(/^(.{1,60}?)\s*[-–—]\s*(.{1,80})$/);
    if (m) return { artist: m[1].trim(), title: m[2].trim() };
    return { artist: "Unknown artist", title: base || "Unknown song" };
  }
  function showLoading(text) {
    var s = $("sheet-loading"), t = $("sheet-loading-text");
    if (t) t.textContent = text;
    if (s) s.hidden = false;
    var b = $("sheet-backdrop"); if (b) b.hidden = false;
  }
  function setLoadingText(text) { var t = $("sheet-loading-text"); if (t) t.textContent = text; }
  function hideLoading() {
    var s = $("sheet-loading"); if (s) s.hidden = true;
    var anyOpen = !$("sheet-song").hidden || !$("sheet-playlists").hidden;
    var b = $("sheet-backdrop"); if (b) b.hidden = !anyOpen;
  }

  function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(looksAudio);
    if (!files.length) { toast("No audio files found — pick MP3, M4A, WAV, OGG or FLAC."); return; }
    var done = 0, ok = 0, bad = 0;
    showLoading("Importing 1/" + files.length + "…");

    function next() {
      if (done >= files.length) {
        hideLoading();
        renderLibrary();
        renderPlaylists();
        if (ok) toast(ok + " song" + (ok > 1 ? "s" : "") + " added to your library.");
        if (bad) toast(bad + " file" + (bad > 1 ? "s" : "") + " could not be decoded.", true);
        updateStorageStats();
        return;
      }
      var f = files[done++];
      setLoadingText("Importing " + done + "/" + files.length + "…");
      var r = new FileReader();
      r.onload = function () {
        decodeArrayBuffer(r.result).then(function (buf) {
          var parsed = parseName(f.name);
          var rec = {
            id: uid(),
            title: parsed.title,
            artist: parsed.artist,
            name: f.name,
            duration: buf.duration,
            favorite: false,
            dateAdded: Date.now(),
            blob: f
          };
          library.push(rec);
          idbPut(STORE_SONGS, rec);
          cacheBuffer(rec.id, buf);
          ok++;
          next();
        }, function () { bad++; next(); });
      };
      r.onerror = function () { bad++; next(); };
      r.readAsArrayBuffer(f);
    }
    next();
  }

  /* ---------- library rendering ---------- */
  function visibleSongIds() {
    return viewSongs().map(function (s) { return s.id; });
  }
  function viewSongs() {
    var list = library.slice();
    if (libTab === "favorites") list = list.filter(function (s) { return s.favorite; });
    if (artistFilter) list = list.filter(function (s) { return s.artist === artistFilter; });
    if (searchText) {
      var q = searchText.toLowerCase();
      list = list.filter(function (s) {
        return (s.title + " " + s.artist).toLowerCase().indexOf(q) >= 0;
      });
    }
    if (sortKey === "title") list.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    else if (sortKey === "artist") list.sort(function (a, b) {
      var d = String(a.artist).localeCompare(String(b.artist));
      return d || String(a.title).localeCompare(String(b.title));
    });
    else if (sortKey === "duration") list.sort(function (a, b) { return (b.duration || 0) - (a.duration || 0); });
    else list.sort(function (a, b) { return (b.dateAdded || 0) - (a.dateAdded || 0); });
    return list;
  }
  function groupArtists(list) {
    var map = {}, names = [];
    list.forEach(function (s) {
      var a = s.artist || "Unknown artist";
      if (!map[a]) { map[a] = { name: a, count: 0, dur: 0 }; names.push(a); }
      map[a].count++; map[a].dur += s.duration || 0;
    });
    names.sort(function (x, y) { return x.localeCompare(y); });
    return names.map(function (n) { return map[n]; });
  }

  function renderLibrary() {
    var songList = $("song-list"), artistList = $("artist-list"), plList = $("playlist-list");
    var plNew = $("pl-new"), empty = $("lib-empty"), back = $("artist-back");
    var emptyTitle = $("empty-title"), emptyText = $("empty-text"), emptyBtn = $("empty-import");
    var isArtists = libTab === "artists" && !artistFilter;
    var isPl = libTab === "playlists";

    songList.hidden = isArtists || isPl;
    artistList.hidden = !isArtists;
    plList.hidden = !isPl;
    plNew.hidden = !isPl;
    back.hidden = !artistFilter;

    var songs = viewSongs();
    var count = $("song-count");
    var totalMin = Math.round(songs.reduce(function (a, s) { return a + (s.duration || 0); }, 0) / 60);
    if (isArtists) {
      var arts = groupArtists(library);
      count.textContent = arts.length ? arts.length + " artist" + (arts.length > 1 ? "s" : "") : "";
      artistList.innerHTML = arts.map(function (a) {
        return '<li data-artist="' + escapeHtml(a.name) + '">' +
          '<span class="artist-avatar" data-hue="' + hashHue(a.name) + '">' + escapeHtml(coverLetter(a.name)) + "</span>" +
          '<span class="song-meta"><span class="artist-name">' + escapeHtml(a.name) + "</span>" +
          '<span class="artist-count">' + a.count + " song" + (a.count > 1 ? "s" : "") + " · " + fmtTime(a.dur) + "</span></span>" +
          '<span class="artist-back artist-arrow" aria-hidden="true">›</span></li>';
      }).join("");
      qsa(".artist-avatar", artistList).forEach(function (el) {
        artStyle(el, el.getAttribute("data-hue") + "");
      });
    } else if (isPl) {
      count.textContent = playlists.length ? playlists.length + " playlist" + (playlists.length > 1 ? "s" : "") : "";
      renderPlaylists();
    } else {
      count.textContent = songs.length
        ? songs.length + " song" + (songs.length > 1 ? "s" : "") + (totalMin ? " · " + totalMin + " min" : "")
        : "";
      songList.innerHTML = songs.map(function (s) {
        return songRowHTML(s);
      }).join("");
      qsa("li[data-song]", songList).forEach(function (li) {
        artStyle(qs1(li, ".song-art"), li.getAttribute("data-song"));
      });
    }

    var showEmpty = (!songs.length && !isArtists && !isPl) || (isArtists && !library.length) || (isPl && !playlists.length);
    empty.hidden = !showEmpty;
    if (showEmpty) {
      if (isPl) {
        emptyTitle.textContent = "No playlists yet";
        emptyText.textContent = "Create your first playlist above, then add songs from the ⋯ menu next to any track.";
        emptyBtn.hidden = true;
      } else if (libTab === "favorites") {
        emptyTitle.textContent = "No favorites yet";
        emptyText.textContent = "Tap the heart next to any song (or on the now-playing screen) and it will show up here.";
        emptyBtn.hidden = true;
      } else if (searchText) {
        emptyTitle.textContent = "Nothing found";
        emptyText.textContent = "No songs match “" + searchText + "”. Try another word or artist name.";
        emptyBtn.hidden = true;
      } else {
        emptyTitle.textContent = "Your library is empty";
        emptyText.textContent = "Import songs from your device. Every song is split into vocals and music while it plays — no uploads, everything stays on this phone.";
        emptyBtn.hidden = false;
      }
    }
    updateTopbarSub();
    markCurrentRow();
  }

  function qs1(root, sel) { return root.querySelector(sel); }

  function songRowHTML(s) {
    return '<li data-song="' + escapeHtml(s.id) + '"' + (s.id === currentId ? ' class="is-current"' : "") + ">" +
      '<span class="song-art">' + escapeHtml(coverLetter(s.title)) + "</span>" +
      '<span class="song-meta"><span class="song-title">' + escapeHtml(s.title) + "</span>" +
      '<span class="song-artist">' + escapeHtml(s.artist) + "</span></span>" +
      '<span class="song-end"><span class="song-playing-mark" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="song-dur">' + fmtTime(s.duration) + "</span>" +
      '<button type="button" class="song-fav' + (s.favorite ? " is-on" : "") + '" data-fav="' + escapeHtml(s.id) + '" aria-label="Toggle favorite" aria-pressed="' + (s.favorite ? "true" : "false") + '">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" stroke-width="1.9"><path d="M12 20.3l-5.7-5.7a4.5 4.5 0 1 1 6.4-6.4l.3.3.3-.3a4.5 4.5 0 1 1 6.4 6.4z" transform="translate(-1.5 -.5)"/></svg></button>' +
      '<button type="button" class="song-more" data-more="' + escapeHtml(s.id) + '" aria-label="Song options">⋯</button>' +
      "</span></li>";
  }

  function markCurrentRow() {
    qsa("#song-list li").forEach(function (li) {
      li.classList.toggle("is-current", li.getAttribute("data-song") === currentId);
    });
  }

  function renderPlaylists() {
    var plList = $("playlist-list");
    if (!plList || plList.hidden) return;
    plList.innerHTML = playlists.map(function (pl) {
      var songs = pl.songIds.map(songById).filter(Boolean);
      var dur = songs.reduce(function (a, s) { return a + (s.duration || 0); }, 0);
      return '<li data-pl="' + escapeHtml(pl.id) + '"><div class="pl-card">' +
        '<div class="pl-head">' +
        '<button type="button" class="pl-play" data-plplay="' + escapeHtml(pl.id) + '" aria-label="Play playlist">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg></button>' +
        '<span class="pl-title">' + escapeHtml(pl.name) + "</span>" +
        '<span class="pl-count">' + songs.length + " · " + fmtTime(dur) + "</span>" +
        '<button type="button" class="pl-del" data-pldel="' + escapeHtml(pl.id) + '" aria-label="Delete playlist">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg></button>' +
        "</div>" +
        '<div class="pl-songs"><ul class="song-list">' +
        songs.map(function (s) { return songRowHTML(s); }).join("") +
        "</ul></div></div></li>";
    }).join("");
    qsa("#playlist-list .song-art").forEach(function (el) {
      var li = el.closest("li[data-song]");
      if (li) artStyle(el, li.getAttribute("data-song"));
    });
  }

  /* ---------- queue rendering ---------- */
  function upcomingList() {
    var out = [];
    for (var i = 0; i < queue.length; i++) out.push({ id: queue[i], fromQueue: true, idx: i });
    if (contextIds.length) {
      var order = activeOrder();
      var pos = order.indexOf(currentId);
      for (var j = pos + 1; j < order.length; j++) out.push({ id: order[j], fromQueue: false, idx: j });
      if (settings.repeat === "all") {
        for (var k = 0; k < pos && k < order.length; k++) out.push({ id: order[k], fromQueue: false, idx: k });
      }
    }
    return out;
  }
  function renderQueue() {
    var list = $("queue-list"), count = $("queue-count");
    if (!list) return;
    var up = upcomingList();
    if (count) count.textContent = String(up.length);
    if (!up.length) {
      list.innerHTML = '<li style="display:block;text-align:center;color:var(--text-3);font-size:13px;padding:22px 10px;">Nothing queued. Play a song and the rest of its list shows up here.</li>';
      return;
    }
    list.innerHTML = up.map(function (item, i) {
      var s = songById(item.id);
      if (!s) return "";
      return '<li data-qi="' + i + '"' + (i === 0 && queue.length === 0 ? "" : "") + ">" +
        '<span class="q-num">' + (item.fromQueue ? "⭐" : (i + 1)) + "</span>" +
        '<span class="song-art" style="width:38px;height:38px;border-radius:10px;font-size:13px;">' + escapeHtml(coverLetter(s.title)) + "</span>" +
        '<span class="song-meta"><span class="q-title">' + escapeHtml(s.title) + "</span>" +
        '<span class="q-artist">' + escapeHtml(s.artist) + "</span></span>" +
        '<span class="q-dur">' + fmtTime(s.duration) + "</span></li>";
    }).join("");
    qsa("#queue-list .song-art").forEach(function (el) {
      var li = el.closest("li[data-qi]");
      if (li) artStyle(el, "q" + li.getAttribute("data-qi") + li.querySelector(".q-title").textContent);
    });
  }

  /* ---------- now playing UI ---------- */
  function updateNowPlayingUI() {
    var s = currentSong();
    var npTitle = $("np-title"), npArtist = $("np-artist"), npArt = $("np-art");
    if (!s) {
      if (npTitle) npTitle.textContent = "Nothing playing";
      if (npArtist) npArtist.textContent = "Import music in the Library tab";
      return;
    }
    if (npTitle) npTitle.textContent = s.title;
    if (npArtist) npArtist.textContent = s.artist;
    if (npArt) {
      var hue = artStyle(npArt, s.title + "·" + s.artist);
      npArt.setAttribute("data-hue", String(hue));
    }
    updateFavUI();
    updateProgressUI();
    var total = $("np-time-total");
    if (total) total.textContent = fmtTime(duration || s.duration);
  }

  function updateMini() {
    var mini = $("mini"), s = currentSong();
    if (!mini) return;
    mini.hidden = !s;
    document.body.classList.toggle("mini-on", !!s);
    if (!s) return;
    $("mini-title").textContent = s.title;
    $("mini-sub").textContent = s.artist + " · " + (MODE_NAMES[mode()] || mode());
    var art = $("mini-disc");
    if (art) {
      artStyle(art.parentNode, s.title + "·" + s.artist);
      art.classList.toggle("spinning", playing);
    }
  }

  function updatePlayIcons() {
    var setIcon = function (svgId) {
      var svg = $(svgId);
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", playing ? ICON_PAUSE : ICON_PLAY);
      svg.appendChild(p);
    };
    setIcon("np-play-icon");
    setIcon("mini-play-icon");
    var disc = $("np-disc");
    if (disc) disc.classList.toggle("spinning", playing);
    var mdisc = $("mini-disc");
    if (mdisc) mdisc.classList.toggle("spinning", playing);
    var npPlay = $("np-play");
    if (npPlay) npPlay.setAttribute("aria-label", playing ? "Pause" : "Play");
    updateMini();
    markCurrentRow();
  }

  function updateFavUI() {
    var s = currentSong();
    var btn = $("np-fav");
    if (btn) {
      btn.classList.toggle("is-on", !!(s && s.favorite));
      btn.setAttribute("aria-pressed", s && s.favorite ? "true" : "false");
    }
  }

  function updateProgressUI() {
    var pos = currentPos();
    var ratio = duration ? pos / duration : 0;
    var fill = $("np-progress-fill"), knob = $("np-progress-knob"), prog = $("np-progress");
    if (fill) fill.style.width = (ratio * 100).toFixed(2) + "%";
    if (knob) knob.style.left = (ratio * 100).toFixed(2) + "%";
    if (prog) prog.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    var cur = $("np-time-cur");
    if (cur) cur.textContent = fmtTime(pos);
    var mf = $("mini-prog-fill");
    if (mf) mf.style.width = (ratio * 100).toFixed(2) + "%";
  }

  function seekRatio(ratio) {
    if (!buffer) return;
    ratio = Math.max(0, Math.min(1, ratio));
    var target = ratio * duration;
    if (playing) startAt(target);
    else { offsetBase = target; updateProgressUI(); }
  }

  function updateTopbarSub() {
    var el = $("topbar-sub");
    if (!el) return;
    if (!library.length) { el.textContent = "Your music, two tracks"; return; }
    var dur = library.reduce(function (a, s) { return a + (s.duration || 0); }, 0);
    el.textContent = library.length + " songs · " + fmtTime(dur) + " of music";
  }

  /* ---------- split / mode UI ---------- */
  function updateSplitMethod() {
    var chip = $("split-method"), txt = $("split-method-text");
    if (!chip || !txt) return;
    if (!buffer) {
      chip.className = "method-chip";
      txt.textContent = "Load a song to analyze it";
      return;
    }
    chip.className = "method-chip " + (stereo ? "is-stereo" : "is-mono");
    txt.textContent = stereo
      ? "True stereo detected — 3-way crossover, the centered voice is removed from the mid band only"
      : "Mono or twin-channel detected — smooth band-focused cancellation (no spectral hole)";
  }
  function updateModeUI() {
    qsa("[data-mode]").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-mode") === mode());
    });
    var mm = $("mini-mode");
    if (mm) {
      mm.textContent = MODE_ICONS[mode()] || "🎧";
      mm.title = "Mode: " + (MODE_NAMES[mode()] || mode());
    }
    var sub = $("mini-sub"), s = currentSong();
    if (sub && s) sub.textContent = s.artist + " · " + (MODE_NAMES[mode()] || mode());
  }
  function setMode(m) {
    if (["original", "vocals", "karaoke", "custom"].indexOf(m) < 0) m = "original";
    if (m === "custom") { settings.stemV = settings.customV; settings.stemI = settings.customI; }
    else { settings.customV = settings.stemV; settings.customI = settings.stemI; }
    settings.mode = m;
    saveSettings();
    applyStemGains();
    updateModeUI();
    updateStemUI();
    if (m !== "original") toast(MODE_ICONS[m] + " " + MODE_NAMES[m]);
  }
  function updateStemUI() {
    var sv = $("stem-vocal"), si = $("stem-music");
    if (sv) { sv.value = String(settings.stemV); $("stem-vocal-val").textContent = settings.stemV + "%"; }
    if (si) { si.value = String(settings.stemI); $("stem-music-val").textContent = settings.stemI + "%"; }
    var mv = $("mute-vocal"), mi = $("mute-music"), slv = $("solo-vocal"), sli = $("solo-music");
    if (mv) { mv.classList.toggle("is-on", muteV); mv.setAttribute("aria-pressed", muteV ? "true" : "false"); }
    if (mi) { mi.classList.toggle("is-on", muteI); mi.setAttribute("aria-pressed", muteI ? "true" : "false"); }
    if (slv) { slv.classList.toggle("is-on", soloV); slv.setAttribute("aria-pressed", soloV ? "true" : "false"); }
    if (sli) { sli.classList.toggle("is-on", soloI); sli.setAttribute("aria-pressed", soloI ? "true" : "false"); }
  }
  function updateStrengthUI() {
    var st = $("strength");
    if (st) { st.value = String(settings.strength); $("strength-val").textContent = settings.strength + "%"; }
    var sst = $("set-strength");
    if (sst) { sst.value = String(settings.strength); $("set-strength-val").textContent = settings.strength + "%"; }
  }
  function applyStrength(val) {
    settings.strength = Math.max(0, Math.min(100, Math.round(Number(val) || 0)));
    saveSettings();
    if (stems) stems.setStrength(settings.strength / 100);
    updateStrengthUI();
  }

  /* ---------- shuffle / repeat / sleep UI ---------- */
  function updateShuffleRepeatUI() {
    var sh = $("btn-shuffle"), rp = $("btn-repeat");
    if (sh) {
      sh.classList.toggle("is-active", !!settings.shuffle);
      sh.setAttribute("aria-pressed", settings.shuffle ? "true" : "false");
    }
    if (rp) {
      rp.classList.toggle("is-active", settings.repeat !== "off");
      rp.classList.toggle("is-one", settings.repeat === "one");
      rp.setAttribute("aria-pressed", settings.repeat !== "off" ? "true" : "false");
      rp.title = "Repeat: " + settings.repeat;
    }
  }
  function updateSleepLabel() {
    var el = $("sleep-label");
    if (!el) return;
    if (sleepEndOfTrack) { el.hidden = false; el.textContent = "Sleep timer: stopping after this track."; return; }
    if (!sleepAt) { el.hidden = true; return; }
    var left = Math.max(0, Math.ceil((sleepAt - Date.now()) / 60000));
    el.hidden = false;
    el.textContent = "Sleep timer: " + left + " min left.";
  }

  /* ---------- EQ UI ---------- */
  var EQ_PRESETS = {
    flat: [0, 0, 0, 0, 0],
    pop: [-1, 3, 4, 3, -1],
    rock: [4, 2, -1, 2, 4],
    jazz: [3, 1, -1, 2, 3],
    bass: [7, 5, 1, 0, 0],
    vocal: [-2, 0, 3, 5, 4],
    treble: [0, 0, 1, 4, 7]
  };
  function updateEqUI() {
    for (var i = 0; i < 5; i++) {
      var b = $("eq-band-" + i), v = $("eq-val-" + i);
      if (b) b.value = String(settings.eq[i] || 0);
      if (v) v.textContent = (settings.eq[i] > 0 ? "+" : "") + (settings.eq[i] || 0) + " dB";
    }
    var en = $("eq-enabled");
    if (en) { en.classList.toggle("is-on", !!settings.eqOn); en.setAttribute("aria-checked", settings.eqOn ? "true" : "false"); }
    var bands = $("eq-bands");
    if (bands) bands.classList.toggle("is-off", !settings.eqOn);
    var pre = $("eq-preset");
    if (pre) pre.value = settings.eqPreset || "flat";
  }

  /* ---------- sheets ---------- */
  var ovStack = [];
  function ovPush(openFn, closeFn) {
    ovStack.push(closeFn);
    if (openFn) openFn();
    var want = "#ov" + ovStack.length;
    if (location.hash !== want) location.hash = "ov" + ovStack.length;
  }
  function ovClose() {
    if (!ovStack.length) return;
    var m = /^#ov(\d+)$/.exec(location.hash);
    var depth = m ? parseInt(m[1], 10) : 0;
    if (depth >= ovStack.length) history.back();
    else { var c = ovStack.pop(); c(); }
  }
  window.addEventListener("hashchange", function () {
    var m = /^#ov(\d+)$/.exec(location.hash);
    var target = m ? Math.max(1, parseInt(m[1], 10)) : 0;
    while (ovStack.length > target) { var c = ovStack.pop(); c(); }
  });

  function openNowPlaying() {
    var np = $("nowplaying");
    if (np.hidden) ovPush(function () { np.hidden = false; }, function () { np.hidden = true; });
  }
  function closeNowPlaying() { ovClose(); }

  function openSettings() {
    var s = $("settings");
    if (s.hidden) ovPush(function () { s.hidden = false; }, function () { s.hidden = true; });
  }

  var backdrop = $("sheet-backdrop");
  function openSheet(el, html) {
    if (el.hidden) ovPush(function () { el.innerHTML = html; el.hidden = false; backdrop.hidden = false; },
      function () { el.hidden = true; el.innerHTML = ""; backdrop.hidden = true; });
    else { el.innerHTML = html; }
  }
  function closeSheets() {
    ["sheet-song", "sheet-playlists"].forEach(function (id) {
      var el = $(id);
      if (el && !el.hidden) ovClose();
    });
  }

  function songSheet(id) {
    var s = songById(id);
    if (!s) return;
    var html = '<div class="sheet-grab" aria-hidden="true"></div>' +
      '<h3>' + escapeHtml(s.title) + "</h3>" +
      '<p class="sheet-sub">' + escapeHtml(s.artist) + " · " + fmtTime(s.duration) + "</p>" +
      '<button type="button" class="sheet-item" data-act="play"><span class="ic">▶</span>Play now</button>' +
      '<button type="button" class="sheet-item" data-act="next"><span class="ic">⏭</span>Play next</button>' +
      '<button type="button" class="sheet-item" data-act="pl"><span class="ic">＋</span>Add to playlist</button>' +
      '<button type="button" class="sheet-item" data-act="fav"><span class="ic">' + (s.favorite ? "★" : "☆") + "</span>" + (s.favorite ? "Remove from favorites" : "Add to favorites") + "</button>" +
      '<button type="button" class="sheet-item is-danger" data-act="del"><span class="ic">🗑</span>Remove from library</button>';
    var sheet = $("sheet-song");
    openSheet(sheet, html);
    sheet.setAttribute("data-song", id);
  }
  function playlistPickerSheet(songId) {
    var html = '<div class="sheet-grab" aria-hidden="true"></div>' +
      "<h3>Add to playlist</h3>" +
      '<p class="sheet-sub">Pick a playlist for this song.</p>';
    if (!playlists.length) html += '<p class="sheet-sub">No playlists yet — create one below.</p>';
    playlists.forEach(function (pl) {
      html += '<button type="button" class="sheet-item" data-plid="' + escapeHtml(pl.id) + '"><span class="ic">🎵</span>' + escapeHtml(pl.name) + "</button>";
    });
    html += '<div class="sheet-new"><input type="text" id="sheet-pl-name" placeholder="New playlist name" maxlength="40" aria-label="New playlist name" /><button type="button" class="btn-accent" id="sheet-pl-add">Create</button></div>';
    var sheet = $("sheet-playlists");
    openSheet(sheet, html);
    sheet.setAttribute("data-song", songId);
  }

  function toggleFav(id) {
    var s = songById(id);
    if (!s) return;
    s.favorite = !s.favorite;
    idbPut(STORE_SONGS, s);
    renderLibrary();
    renderPlaylists();
    updateFavUI();
    toast(s.favorite ? "★ Added to favorites." : "Removed from favorites.");
  }
  function removeSong(id) {
    var s = songById(id);
    if (!s) return;
    var wasCurrent = id === currentId;
    library = library.filter(function (x) { return x.id !== id; });
    queue = queue.filter(function (x) { return x !== id; });
    contextIds = contextIds.filter(function (x) { return x !== id; });
    playlists.forEach(function (p) { p.songIds = p.songIds.filter(function (x) { return x !== id; }); idbPut(STORE_PL, p); });
    idbDel(STORE_SONGS, id);
    if (wasCurrent) {
      stopSource();
      playing = false; buffer = null; currentId = null; duration = 0; offsetBase = 0;
      stems = null; graphV = graphI = null;
      updatePlayIcons(); updateNowPlayingUI(); updateMini(); updateProgressUI();
    }
    renderLibrary(); renderPlaylists(); renderQueue();
    toast("“" + s.title + "” removed.");
  }

  /* ---------- WAV export ---------- */
  function encodeWAV(buf) {
    var ch = Math.min(2, buf.numberOfChannels);
    var len = buf.length;
    var ab = new ArrayBuffer(44 + len * ch * 2);
    var v = new DataView(ab);
    var o = 0;
    function wstr(s) { for (var i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); }
    function u32(x) { v.setUint32(o, x, true); o += 4; }
    function u16(x) { v.setUint16(o, x, true); o += 2; }
    wstr("RIFF"); u32(36 + len * ch * 2); wstr("WAVE");
    wstr("fmt "); u32(16); u16(1); u16(ch); u32(buf.sampleRate);
    u32(buf.sampleRate * ch * 2); u16(ch * 2); u16(16);
    wstr("data"); u32(len * ch * 2);
    var chans = [];
    for (var c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    for (var i = 0; i < len; i++) {
      for (var c2 = 0; c2 < ch; c2++) {
        var x = chans[c2][i];
        x = Math.max(-1, Math.min(1, x));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
        o += 2;
      }
    }
    return new Uint8Array(ab);
  }
  function bytesToBase64(bytes) {
    var out = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return btoa(out);
  }
  function sanitizeName(s) {
    return String(s || "song").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "song";
  }
  function saveWavFile(name, bytes) {
    var b = bridge();
    if (b && b.saveFileBegin) {
      try {
        b.saveFileBegin(name);
        var CH = 512 * 1024;
        for (var i = 0; i < bytes.length; i += CH) {
          b.saveFileChunk(bytesToBase64(bytes.subarray(i, Math.min(i + CH, bytes.length))));
        }
        var path = b.saveFileEnd();
        if (path) { toast("Saved: " + path); return; }
        toast("Export could not be written to storage.", true);
        return;
      } catch (e) {
        toast("Export failed: " + (e && e.message ? e.message : e), true);
        return;
      }
    }
    /* browser fallback */
    try {
      var blob = new Blob([bytes], { type: "audio/wav" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 4000);
      toast("Export started: " + name);
    } catch (e) {
      toast("Export failed in this browser.", true);
    }
  }
  function renderExport(kind) {
    if (!buffer || exporting) return;
    if (duration > 12 * 60) { toast("Song is longer than 12 minutes — too long to export here.", true); return; }
    var s = currentSong();
    exporting = true;
    showLoading("Rendering " + (MODE_NAMES[kind] || kind) + "…");
    var opts = { strength: settings.strength / 100 };
    if (kind === "mix") { opts.mixV = settings.stemV / 100; opts.mixI = settings.stemI / 100; }
    VPIsolator.renderStems(buffer, kind, opts).then(function (res) {
      var bytes = encodeWAV(res.buffer);
      hideLoading();
      exporting = false;
      var base = sanitizeName((s ? s.artist + " - " + s.title : "song"));
      saveWavFile(base + " (" + kind + ").wav", bytes);
    }).catch(function () {
      hideLoading();
      exporting = false;
      toast("Render failed — try a shorter song.", true);
    });
  }

  /* ---------- storage stats ---------- */
  function updateStorageStats() {
    var el = $("storage-stats");
    if (!el) return;
    var n = library.length;
    var bytes = library.reduce(function (a, s) { return a + (s.blob && s.blob.size ? s.blob.size : 0); }, 0);
    var mb = (bytes / 1048576).toFixed(1);
    var txt = n + " song" + (n === 1 ? "" : "s") + " · " + mb + " MB stored on this device";
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        if (est && est.quota) {
          el.textContent = txt + " · " + (est.usage / 1048576).toFixed(1) + " / " + (est.quota / 1048576).toFixed(0) + " MB used";
        } else el.textContent = txt;
      }).catch(function () { el.textContent = txt; });
    } else el.textContent = txt;
  }

  /* ---------- media session (headphone / lockscreen, if supported) ---------- */
  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      var s = currentSong();
      if (!s) return;
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: s.title,
        artist: s.artist,
        album: "VocalPure"
      });
    } catch (e) { /* not supported */ }
  }

  /* ---------- animation loop (progress, meters, viz) ---------- */
  var rafId = null;
  function drawMeter(canvas, analyser, data, color) {
    if (!canvas || !analyser) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    analyser.getByteTimeDomainData(data);
    var peak = 0;
    for (var i = 0; i < data.length; i++) {
      var d = Math.abs(data[i] - 128) / 128;
      if (d > peak) peak = d;
    }
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,.06)";
    ctx.fillRect(0, h / 2 - 1.25, w, 2.5);
    ctx.fillStyle = color;
    var bars = 26, bw = w / bars;
    for (var b = 0; b < bars; b++) {
      var lvl = Math.max(0.03, peak * (0.55 + 0.45 * Math.sin(b * 1.7 + performance.now() / 130)));
      var bh = Math.min(h, lvl * h);
      ctx.fillRect(b * bw + 1, (h - bh) / 2, Math.max(1.5, bw - 2.5), bh);
    }
  }
  function drawViz() {
    var cv = $("np-bg");
    if (!cv || !analyser) return;
    var ctx = cv.getContext("2d");
    if (!ctx) return;
    var rect = cv.parentNode.getBoundingClientRect();
    var w = Math.max(200, Math.floor(rect.width)), h = Math.max(300, Math.floor(rect.height));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.clearRect(0, 0, w, h);
    analyser.getByteFrequencyData(freqData);
    var n = 36;
    var bw = w / n;
    for (var i = 0; i < n; i++) {
      var v = freqData[Math.floor(i * freqData.length / n * 0.7)] / 255;
      var bh = v * h * 0.5;
      var x = i * bw;
      var grad = ctx.createLinearGradient(0, h, 0, h - bh);
      grad.addColorStop(0, "rgba(48,229,165,.35)");
      grad.addColorStop(1, "rgba(76,195,255,.08)");
      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, h - bh, bw - 2, bh);
    }
  }
  function loop() {
    if (playing) updateProgressUI();
    var splitActive = $("screen-split").classList.contains("is-active");
    if (splitActive && actx) {
      drawMeter($("meter-vocal"), analyserV, meterDataV, "#FFC53D");
      drawMeter($("meter-music"), analyserM, meterDataM, "#4CC3FF");
    }
    var npOpen = !$("nowplaying").hidden;
    if (npOpen && actx) drawViz();
    rafId = requestAnimationFrame(loop);
  }

  /* ---------- navigation ---------- */
  function switchScreen(name) {
    qsa(".screen").forEach(function (s) { s.classList.toggle("is-active", s.getAttribute("id") === "screen-" + name); });
    qsa(".tab").forEach(function (t) { t.classList.toggle("is-active", t.getAttribute("data-nav") === name); });
    if (name === "queue") renderQueue();
  }

  /* ---------- keyboard (desktop preview) ---------- */
  document.addEventListener("keydown", function (e) {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "ArrowRight" && e.shiftKey) stepNext(true);
    else if (e.code === "ArrowLeft" && e.shiftKey) stepPrev();
    else if (e.code === "ArrowRight") seekRatio((currentPos() + 5) / (duration || 1));
    else if (e.code === "ArrowLeft") seekRatio((currentPos() - 5) / (duration || 1));
  });

  /* ============================================================
     events
     ============================================================ */
  var fileInput = $("file-input");
  function openPicker() { if (fileInput) fileInput.click(); }
  on($("fab-import"), "click", openPicker);
  on($("empty-import"), "click", openPicker);
  on(fileInput, "change", function () {
    if (fileInput.files && fileInput.files.length) importFiles(fileInput.files);
    fileInput.value = "";
  });

  /* drag & drop import (desktop preview of the app) */
  ["dragover", "drop"].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  document.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  /* library tabs */
  on($("lib-tabs"), "click", function (e) {
    var b = e.target.closest("[data-libtab]");
    if (!b) return;
    libTab = b.getAttribute("data-libtab");
    artistFilter = "";
    qsa("#lib-tabs .seg-btn").forEach(function (x) {
      var act = x === b;
      x.classList.toggle("is-active", act);
      x.setAttribute("aria-selected", act ? "true" : "false");
    });
    renderLibrary();
  });

  on($("song-search"), "input", function (e) {
    searchText = e.target.value.trim();
    renderLibrary();
  });
  on($("song-sort"), "change", function (e) {
    sortKey = e.target.value;
    renderLibrary();
  });
  on($("artist-back-btn"), "click", function () {
    artistFilter = "";
    renderLibrary();
  });

  /* song list interactions */
  on($("song-list"), "click", function (e) {
    var fav = e.target.closest("[data-fav]");
    if (fav) { toggleFav(fav.getAttribute("data-fav")); e.stopPropagation(); return; }
    var more = e.target.closest("[data-more]");
    if (more) { songSheet(more.getAttribute("data-more")); return; }
    var li = e.target.closest("li[data-song]");
    if (!li) return;
    var id = li.getAttribute("data-song");
    var ids = visibleSongIds();
    playFromContext(ids.length ? ids : [id], Math.max(0, ids.indexOf(id)));
    openNowPlaying();
  });
  on($("artist-list"), "click", function (e) {
    var li = e.target.closest("li[data-artist]");
    if (!li) return;
    artistFilter = li.getAttribute("data-artist");
    var nm = $("artist-back-name");
    if (nm) nm.textContent = artistFilter;
    libTab = "songs";
    qsa("#lib-tabs .seg-btn").forEach(function (x) {
      var act = x.getAttribute("data-libtab") === "songs";
      x.classList.toggle("is-active", act);
      x.setAttribute("aria-selected", act ? "true" : "false");
    });
    renderLibrary();
  });

  /* playlists */
  function createPlaylist(name, thenAddSong) {
    name = String(name || "").trim().slice(0, 40);
    if (!name) { toast("Give the playlist a name first."); return null; }
    var pl = { id: uid(), name: name, songIds: [] };
    playlists.push(pl);
    idbPut(STORE_PL, pl);
    renderPlaylists();
    toast("Playlist “" + name + "” created.");
    return pl;
  }
  on($("new-playlist-add"), "click", function () {
    var inp = $("new-playlist-name");
    createPlaylist(inp.value);
    inp.value = "";
  });
  on($("new-playlist-name"), "keydown", function (e) {
    if (e.key === "Enter") { createPlaylist(this.value); this.value = ""; }
  });
  on($("playlist-list"), "click", function (e) {
    var play = e.target.closest("[data-plplay]");
    if (play) {
      var pl = playlists.filter(function (p) { return p.id === play.getAttribute("data-plplay"); })[0];
      if (pl && pl.songIds.length) {
        playFromContext(pl.songIds.slice(), 0);
        openNowPlaying();
      } else toast("This playlist is empty — add songs from the ⋯ menu.");
      return;
    }
    var del = e.target.closest("[data-pldel]");
    if (del) {
      var plid = del.getAttribute("data-pldel");
      var plx = playlists.filter(function (p) { return p.id === plid; })[0];
      playlists = playlists.filter(function (p) { return p.id !== plid; });
      idbDel(STORE_PL, plid);
      renderLibrary();
      toast("Playlist “" + (plx ? plx.name : "") + "” deleted.");
      return;
    }
    var li = e.target.closest("li[data-song]");
    if (li) {
      var id = li.getAttribute("data-song");
      var plId = li.closest("li[data-pl]").getAttribute("data-pl");
      var plist = playlists.filter(function (p) { return p.id === plId; })[0];
      var ids = plist ? plist.songIds.slice() : [id];
      playFromContext(ids, Math.max(0, ids.indexOf(id)));
      openNowPlaying();
      return;
    }
    var card = e.target.closest("li[data-pl]");
    if (card) {
      var body = card.querySelector(".pl-songs");
      if (body) body.hidden = !body.hidden;
    }
  });

  /* song sheet + playlist picker sheet */
  on($("sheet-song"), "click", function (e) {
    var item = e.target.closest("[data-act]");
    if (!item) return;
    var id = this.getAttribute("data-song");
    var act = item.getAttribute("data-act");
    if (act === "play") {
      var s = songById(id);
      var ids = viewSongs().map(function (x) { return x.id; });
      playFromContext(ids.length ? ids : [id], Math.max(0, ids.indexOf(id)));
      openNowPlaying();
      ovClose();
    } else if (act === "next") {
      queue.push(id);
      renderQueue();
      toast("Playing next: “" + (songById(id) || {}).title + "”.");
      ovClose();
    } else if (act === "pl") {
      ovClose();
      setTimeout(function () { playlistPickerSheet(id); }, 60);
    } else if (act === "fav") {
      toggleFav(id);
      ovClose();
    } else if (act === "del") {
      removeSong(id);
      ovClose();
    }
  });
  on($("sheet-playlists"), "click", function (e) {
    var songId = this.getAttribute("data-song");
    var item = e.target.closest("[data-plid]");
    if (item) {
      var pl = playlists.filter(function (p) { return p.id === item.getAttribute("data-plid"); })[0];
      if (pl) {
        if (pl.songIds.indexOf(songId) < 0) {
          pl.songIds.push(songId);
          idbPut(STORE_PL, pl);
          renderPlaylists();
          toast("Added to “" + pl.name + "”.");
        } else toast("Already in “" + pl.name + "”.");
      }
      ovClose();
      return;
    }
    var addBtn = e.target.closest("#sheet-pl-add");
    if (addBtn) {
      var inp = $("sheet-pl-name");
      var newPl = createPlaylist(inp ? inp.value : "");
      if (newPl && songId) {
        newPl.songIds.push(songId);
        idbPut(STORE_PL, newPl);
        toast("Added to “" + newPl.name + "”.");
      }
      ovClose();
    }
  });
  on($("sheet-playlists"), "keydown", function (e) {
    if (e.key === "Enter" && e.target.id === "sheet-pl-name") {
      var inp = e.target;
      var pl = createPlaylist(inp.value);
      var songId = this.getAttribute("data-song");
      if (pl && songId) { pl.songIds.push(songId); idbPut(STORE_PL, pl); toast("Added to “" + pl.name + "”."); }
      ovClose();
    }
  });
  on(backdrop, "click", closeSheets);

  /* tab navigation */
  qsa(".tab").forEach(function (t) {
    on(t, "click", function () { switchScreen(t.getAttribute("data-nav")); });
  });

  /* mini player */
  on($("mini-art"), "click", openNowPlaying);
  on($("mini-play"), "click", togglePlay);
  on($("mini-prev"), "click", function () { stepPrev(); });
  on($("mini-next"), "click", function () { stepNext(true); });
  on($("mini-mode"), "click", function () {
    if (!buffer) { toast("Play a song first to switch modes."); return; }
    var order = ["original", "vocals", "karaoke", "custom"];
    setMode(order[(order.indexOf(mode()) + 1) % order.length]);
  });

  /* now playing */
  on($("np-close"), "click", closeNowPlaying);
  on($("np-queue"), "click", function () {
    closeNowPlaying();
    setTimeout(function () { switchScreen("queue"); }, 80);
  });
  on($("np-play"), "click", togglePlay);
  on($("btn-prev"), "click", function () { stepPrev(); });
  on($("btn-next"), "click", function () { stepNext(true); });
  on($("np-fav"), "click", function () { if (currentId) toggleFav(currentId); });
  on($("btn-shuffle"), "click", function () {
    settings.shuffle = !settings.shuffle;
    shuffleOrder = null;
    saveSettings();
    updateShuffleRepeatUI();
    renderQueue();
    toast(settings.shuffle ? "Shuffle on." : "Shuffle off.");
  });
  on($("btn-repeat"), "click", function () {
    settings.repeat = settings.repeat === "off" ? "all" : (settings.repeat === "all" ? "one" : "off");
    saveSettings();
    updateShuffleRepeatUI();
    renderQueue();
    toast("Repeat: " + settings.repeat + ".");
  });

  var prog = $("np-progress");
  function ratioFromEvent(e) {
    if (!prog) return 0;
    var r = prog.getBoundingClientRect();
    var x = (e.touches && e.touches.length ? e.touches[0].clientX : e.clientX) - r.left;
    return Math.max(0, Math.min(1, r.width ? x / r.width : 0));
  }
  var scrubbing = false;
  on(prog, "pointerdown", function (e) { scrubbing = true; prog.setPointerCapture && prog.setPointerCapture(e.pointerId); });
  on(prog, "pointermove", function (e) { if (scrubbing) seekRatio(ratioFromEvent(e)); });
  on(prog, "pointerup", function (e) { if (scrubbing) { scrubbing = false; seekRatio(ratioFromEvent(e)); } });
  on(prog, "pointercancel", function () { scrubbing = false; });
  on(prog, "click", function (e) { seekRatio(ratioFromEvent(e)); });
  on(prog, "keydown", function (e) {
    if (!duration) return;
    if (e.key === "ArrowRight") { seekRatio((currentPos() + 5) / duration); e.preventDefault(); }
    if (e.key === "ArrowLeft") { seekRatio((currentPos() - 5) / duration); e.preventDefault(); }
  });

  on($("np-volume"), "input", function () {
    settings.volume = parseInt(this.value, 10) || 0;
    muted = false;
    saveSettings();
    applyVolume();
  });
  on($("mute-btn"), "click", function () {
    muted = !muted;
    applyVolume();
  });
  on($("playback-rate"), "change", function () {
    var r = parseFloat(this.value) || 1;
    settings.rate = r;
    saveSettings();
    if (playing && buffer) {
      offsetBase = currentPos();
      startCtxTime = actx.currentTime;
      if (source) source.playbackRate.value = r;
    }
    toast("Speed: " + r + "×");
  });
  on($("sleep-timer"), "change", function () {
    var v = this.value;
    sleepAt = 0;
    sleepEndOfTrack = false;
    if (v === "track") sleepEndOfTrack = true;
    else if (v !== "0") sleepAt = Date.now() + parseInt(v, 10) * 60000;
    updateSleepLabel();
    toast(v === "0" ? "Sleep timer off." : (v === "track" ? "Will stop after this track." : "Sleep timer: " + v + " minutes."));
  });

  /* mode chips (split screen + now playing) */
  qsa("[data-mode]").forEach(function (b) {
    on(b, "click", function () {
      if (!buffer) { toast("Play a song first — then pick a mode."); return; }
      setMode(b.getAttribute("data-mode"));
    });
  });

  /* stem mixer */
  on($("stem-vocal"), "input", function () {
    settings.stemV = parseInt(this.value, 10) || 0;
    if (mode() !== "custom") settings.mode = "custom";
    saveSettings();
    $("stem-vocal-val").textContent = settings.stemV + "%";
    applyStemGains();
    updateModeUI();
  });
  on($("stem-music"), "input", function () {
    settings.stemI = parseInt(this.value, 10) || 0;
    if (mode() !== "custom") settings.mode = "custom";
    saveSettings();
    $("stem-music-val").textContent = settings.stemI + "%";
    applyStemGains();
    updateModeUI();
  });
  on($("mute-vocal"), "click", function () { muteV = !muteV; updateStemUI(); applyStemGains(); });
  on($("mute-music"), "click", function () { muteI = !muteI; updateStemUI(); applyStemGains(); });
  on($("solo-vocal"), "click", function () { soloV = !soloV; if (soloV) soloI = false; updateStemUI(); applyStemGains(); });
  on($("solo-music"), "click", function () { soloI = !soloI; if (soloI) soloV = false; updateStemUI(); applyStemGains(); });
  on($("strength"), "input", function () { applyStrength(this.value); });

  /* export */
  on($("export-vocals"), "click", function () { renderExport("vocals"); });
  on($("export-karaoke"), "click", function () { renderExport("karaoke"); });
  on($("export-mix"), "click", function () { renderExport("mix"); });

  /* EQ */
  for (var ebi = 0; ebi < 5; ebi++) {
    (function (i) {
      on($("eq-band-" + i), "input", function () {
        settings.eq[i] = parseInt(this.value, 10) || 0;
        settings.eqPreset = "custom";
        saveSettings();
        applyEQ();
        updateEqUI();
      });
    })(ebi);
  }
  on($("eq-preset"), "change", function () {
    var p = this.value;
    settings.eqPreset = p;
    if (EQ_PRESETS[p]) {
      settings.eq = EQ_PRESETS[p].slice();
      applyEQ();
      updateEqUI();
    }
    saveSettings();
  });
  on($("eq-reset"), "click", function () {
    settings.eq = [0, 0, 0, 0, 0];
    settings.eqPreset = "flat";
    saveSettings();
    applyEQ();
    updateEqUI();
  });
  on($("eq-enabled"), "click", function () {
    settings.eqOn = !settings.eqOn;
    saveSettings();
    applyEQ();
    updateEqUI();
  });

  /* queue */
  on($("queue-list"), "click", function (e) {
    var li = e.target.closest("li[data-qi]");
    if (!li) return;
    var up = upcomingList();
    var item = up[parseInt(li.getAttribute("data-qi"), 10)];
    if (!item) return;
    if (item.fromQueue) {
      queue = queue.slice(item.idx + 1);
    } else {
      contextPos = contextIds.indexOf(item.id); // correct even under shuffle
    }
    loadSongById(item.id, true);
    renderQueue();
  });
  on($("queue-clear"), "click", function () {
    queue = [];
    renderQueue();
    toast("Up-next queue cleared.");
  });

  /* settings */
  on($("btn-settings"), "click", openSettings);
  on($("settings-close"), "click", ovClose);
  on($("set-keepscreen"), "click", function () {
    settings.keepScreen = !settings.keepScreen;
    saveSettings();
    this.classList.toggle("is-on", settings.keepScreen);
    this.setAttribute("aria-checked", settings.keepScreen ? "true" : "false");
    var b = bridge();
    if (b && b.setKeepScreenOn) {
      try { b.setKeepScreenOn(settings.keepScreen); } catch (e) { }
    }
    toast(settings.keepScreen ? "Screen stays on while the app is open." : "Keep-screen-on disabled.");
  });
  on($("set-strength"), "input", function () { applyStrength(this.value); });
  var clearArmed = false;
  on($("set-clear"), "click", function () {
    if (!clearArmed) {
      clearArmed = true;
      this.textContent = "Tap again to delete everything";
      var btn = this;
      setTimeout(function () { clearArmed = false; btn.textContent = "Delete all songs & playlists"; }, 3200);
      return;
    }
    clearArmed = false;
    this.textContent = "Delete all songs & playlists";
    stopPlayback();
    library = []; playlists = []; queue = []; contextIds = []; contextPos = -1;
    currentId = null; buffer = null; stems = null; graphV = graphI = null; bufferCache = [];
    idbClear(STORE_SONGS);
    idbClear(STORE_PL);
    renderLibrary();
    renderPlaylists();
    renderQueue();
    updateNowPlayingUI();
    updateMini();
    updateStorageStats();
    toast("All songs and playlists deleted.");
  });

  /* ============================================================
     init
     ============================================================ */
  function init() {
    loadSettings();
    try {
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    } catch (e) { /* file:// quirks */ }

    /* restore persisted library + playlists */
    idbAll(STORE_SONGS).then(function (recs) {
      library = (recs || []).map(function (r) {
        return {
          id: r.id, title: r.title || "Unknown", artist: r.artist || "Unknown artist",
          name: r.name || "", duration: r.duration || 0, blob: r.blob || null,
          favorite: !!r.favorite, dateAdded: r.dateAdded || 0
        };
      }).filter(function (r) { return r.id; });
      renderLibrary();
      if (library.length) toast(library.length + " song" + (library.length > 1 ? "s" : "") + " restored from your library.");
    }).catch(function () {
      idbFailed = true;
      renderLibrary();
    });
    idbAll(STORE_PL).then(function (recs) {
      playlists = (recs || []).filter(function (p) { return p && p.id && p.name; })
        .map(function (p) { return { id: p.id, name: String(p.name).slice(0, 40), songIds: (p.songIds || []).slice() }; });
      renderPlaylists();
    }).catch(function () { });

    /* settings → UI */
    var vol = $("np-volume"); if (vol) vol.value = String(settings.volume);
    var rateSel = $("playback-rate"); if (rateSel) rateSel.value = String(settings.rate);
    var ks = $("set-keepscreen");
    if (ks) {
      ks.classList.toggle("is-on", !!settings.keepScreen);
      ks.setAttribute("aria-checked", settings.keepScreen ? "true" : "false");
    }
    updateEqUI();
    updateShuffleRepeatUI();
    updateStemUI();
    updateStrengthUI();
    updateModeUI();
    updateSplitMethod();
    updateMini();
    updateFavUI();
    renderQueue();
    updateStorageStats();

    /* keep-screen-on restore */
    if (settings.keepScreen) {
      var b = bridge();
      if (b && b.setKeepScreenOn) { try { b.setKeepScreenOn(true); } catch (e) { } }
    }

    /* version / about */
    var info = bridgeInfo();
    if (info && info.versionName) {
      var av = $("about-version");
      if (av) av.textContent = "Version " + info.versionName + " · offline music player with live vocal isolation";
    }

    /* sleep timer tick */
    setInterval(function () {
      if (sleepAt && Date.now() >= sleepAt) {
        sleepAt = 0;
        var sel = $("sleep-timer"); if (sel) sel.value = "0";
        updateSleepLabel();
        pausePlayback();
        toast("Sleep timer — playback paused.");
      } else if (sleepAt) {
        updateSleepLabel();
      }
    }, 1000);

    loop();
  }

  init();

  /* small debug/test surface (also used by automated checks) */
  window.VPApp = {
    version: "3.0.0",
    switchScreen: switchScreen,
    setMode: setMode,
    togglePlay: togglePlay,
    importFiles: importFiles,
    state: function () {
      return {
        songs: library.length, playlists: playlists.length, queue: queue.length,
        currentId: currentId, playing: playing, mode: mode(), strength: settings.strength,
        stereo: stereo, duration: duration
      };
    }
  };
})();
