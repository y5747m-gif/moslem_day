/* ============================================================
   VocalPure app — standalone music player engine
   Library · playlists · favorites · queue · EQ · sleep timer
   + adaptive two-track vocal isolation (engine v5)

   Engine v5 (what changed vs v4):
     · AUTO PURIFY — every song is analyzed automatically the
       moment it is imported (batch FFT, in the background) and
       its music (instruments) is removed automatically on
       playback: pure vocals with zero taps. A settings switch
       turns the automation off; manual modes always win per track.
     · clarity ring + live strategy card on the Now Playing screen

   Engine v4 (kept as the analysis core):
     · every song is pre-analyzed with a real FFT: center-vs-side
       energy in the vocal band decides the strategy per track
     · stereo "center": 3-band mid extraction (body/core/air) +
       presence peak, side+returned-bass music stem
     · stereo "blend": wide mixes get a center+vocal-reverb
       blend instead of a hollow pure-mid
     · mono: sharper notch on the music stem, stronger vocal
       presence peak
     · per-stem compressor with makeup gain (no clipping, ever)
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- tiny dom helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  var toastWrap = $("toast-wrap");
  function toast(msg, type) {
    if (!toastWrap) return;
    while (toastWrap.children.length >= 3) toastWrap.removeChild(toastWrap.firstChild);
    var el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = msg;
    toastWrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity .4s, transform .4s";
      el.style.opacity = "0"; el.style.transform = "translateY(8px)";
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 450);
    }, 2800);
  }
  function uid() { return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
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
    return (t.charAt(0) || "♪").toUpperCase();
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }
  function fmtSize(bytes) {
    if (!bytes) return "0 MB";
    var mb = bytes / (1024 * 1024);
    return mb >= 100 ? Math.round(mb) + " MB" : mb.toFixed(1) + " MB";
  }

  /* ---------------- persistent settings ---------------- */
  var SETTINGS_KEY = "vp-app-settings-v2";
  var settings = {
    volume: 80, rate: 1, mode: "original", autoPurify: true,
    stemV: 100, stemI: 100, customV: 70, customI: 70,
    eqOn: true, eq: [0, 0, 0, 0, 0], eqPreset: "normal",
    shuffle: false, repeat: "off"
  };
  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var s = JSON.parse(raw) || {};
      for (var k in settings) {
        if (s[k] === undefined || s[k] === null) continue;
        if (k === "eq" && Array.isArray(s[k]) && s[k].length === 5) {
          settings.eq = s[k].map(function (v) { return Math.max(-12, Math.min(12, Number(v) || 0)); });
        } else settings[k] = s[k];
      }
      if (["original", "vocals", "karaoke", "custom"].indexOf(settings.mode) < 0) settings.mode = "original";
      if (["off", "all", "one"].indexOf(settings.repeat) < 0) settings.repeat = "off";
    } catch (e) { /* defaults */ }
  }
  function saveSettings() {
    try {
      settings.volume = volume; settings.rate = playbackRate; settings.mode = mode;
      settings.stemV = stemV; settings.stemI = stemI;
      settings.customV = customMem.v; settings.customI = customMem.i;
      settings.eqOn = eqOn; settings.eq = eqGains.slice(); settings.eqPreset = eqPresetName;
      settings.shuffle = shuffle; settings.repeat = repeatMode;
      settings.autoPurify = autoPurify;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- IndexedDB song storage ---------------- */
  var IDB_NAME = "vp-app-db", IDB_STORE = "songs";
  var idbDb = null, idbFailed = false;
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (idbDb) { res(idbDb); return; }
      if (!window.indexedDB) { rej(new Error("no indexedDB")); return; }
      var req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: "id" });
      };
      req.onsuccess = function () { idbDb = req.result; res(idbDb); };
      req.onerror = function () { rej(req.error || new Error("idb")); };
      req.onblocked = function () { rej(new Error("idb blocked")); };
    });
  }
  function idbAll() {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, "readonly");
        var rq = tx.objectStore(IDB_STORE).getAll();
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { rej(rq.error || new Error("idb read")); };
      });
    });
  }
  function idbPut(rec) {
    if (idbFailed || !window.indexedDB) return;
    idbOpen().then(function (db) {
      var tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(rec);
    }).catch(function () { idbFailed = true; });
  }
  function idbDel(id) {
    if (idbFailed || !window.indexedDB) return;
    idbOpen().then(function (db) {
      var tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(id);
    }).catch(function () { /* ignore */ });
  }
  function cleanRec(s) {
    return {
      id: s.id, title: s.title, artist: s.artist, name: s.name,
      duration: s.duration || 0, blob: s.blob || null, favorite: !!s.favorite,
      dateAdded: s.dateAdded || Date.now(), profile: s._profile || null,
      size: s.size || (s.blob && s.blob.size ? s.blob.size : 0),
      path: s.path || null
    };
  }

  /* ---------------- playlists ---------------- */
  var PLAYLISTS_KEY = "vp-app-playlists-v2";
  var playlists = [];
  function loadPlaylists() {
    try {
      var raw = localStorage.getItem(PLAYLISTS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      playlists = (arr || []).filter(function (p) { return p && p.id && p.name; })
        .map(function (p) { return { id: p.id, name: String(p.name).slice(0, 40), songIds: (p.songIds || []).slice() }; });
    } catch (e) { playlists = []; }
  }
  function savePlaylists() {
    try { localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists)); } catch (e) { /* ignore */ }
  }
  function prunePlaylists() {
    var alive = {};
    for (var i = 0; i < library.length; i++) alive[library[i].id] = true;
    for (var p = 0; p < playlists.length; p++) {
      playlists[p].songIds = playlists[p].songIds.filter(function (id) { return alive[id]; });
    }
  }

  /* ============================================================
     Library state
     ============================================================ */
  var library = [];
  var currentId = null;
  var currentViewIds = [];
  var searchQuery = "";
  var openPlaylistId = null;

  function songById(id) {
    for (var i = 0; i < library.length; i++) if (library[i].id === id) return library[i];
    return null;
  }
  function currentSong() { return currentId ? songById(currentId) : null; }

  function viewHome() {
    var list = library.slice().sort(function (a, b) { return (b.dateAdded || 0) - (a.dateAdded || 0); });
    currentViewIds = list.map(function (s) { return s.id; });
    return list;
  }
  function viewSearch() {
    if (!searchQuery) return [];
    var q = searchQuery.toLowerCase();
    return library.filter(function (s) {
      return (s.title + " " + s.artist).toLowerCase().indexOf(q) >= 0;
    });
  }

  /* ============================================================
     FFT + per-song analysis (strategy picker)
     ============================================================ */
  function fft(re, im) {
    var n = re.length, i, j, bit, len, ang, wr, wi, k, u, ui, v, vi, cwr, cwi, nwr;
    for (i = 1, j = 0; i < n; i++) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (len = 2; len <= n; len <<= 1) {
      ang = -2 * Math.PI / len;
      wr = Math.cos(ang); wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        cwr = 1; cwi = 0;
        for (k = 0; k < len / 2; k++) {
          u = re[i + k]; ui = im[i + k];
          v = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
          vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
          re[i + k] = u + v; im[i + k] = ui + vi;
          re[i + k + len / 2] = u - v; im[i + k + len / 2] = ui - vi;
          nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
    }
  }

  /**
   * Measures where a track's vocal-band energy lives.
   * Returns { stereo, centerRatio, bandFocus, strategy, clarity }
   */
  function analyzeBuffer(buf) {
    var sr = buf.sampleRate;
    var nch = buf.numberOfChannels;
    var L = buf.getChannelData(0);
    var R = nch >= 2 ? buf.getChannelData(1) : null;
    var stereo = nch >= 2;

    var N = 1024;
    var hop = 512;
    var maxFrames = Math.max(8, Math.floor((Math.min(buf.duration, 6) * sr) / hop));
    var start = Math.min(L.length - N, Math.floor(Math.random() * Math.max(1, L.length - N - 10000)));
    if (start < 0) start = 0;

    var reL = new Float64Array(N), imL = new Float64Array(N);
    var reR = new Float64Array(N), imR = new Float64Array(N);
    var vocalMid = 0, vocalSide = 0, lowMid = 0, lowSide = 0, highMid = 0, highSide = 0;
    var bandPow = 0, totalPow = 0;

    function addFrame(off) {
      var i;
      for (i = 0; i < N; i++) {
        reL[i] = L[off + i] || 0; imL[i] = 0;
        if (stereo) { reR[i] = R[off + i] || 0; imR[i] = 0; }
        else { reR[i] = reL[i]; imR[i] = 0; }
      }
      fft(reL, imL);
      if (stereo) fft(reR, imR);
      for (var b = 1; b <= N / 2; b++) {
        var f = b * sr / N;
        var midR = (reL[b] + reR[b]) * 0.5, midI = (imL[b] + imR[b]) * 0.5;
        var mp = midR * midR + midI * midI;
        var sp2, sI;
        if (stereo) {
          sp2 = (reL[b] - reR[b]) * 0.5; sI = (imL[b] - imR[b]) * 0.5;
        } else { sp2 = 0; sI = 0; }
        var spow = sp2 * sp2 + sI * sI;
        if (f >= 30 && f < 150) { lowMid += mp; lowSide += spow; }
        else if (f >= 150 && f < 4300) { vocalMid += mp; vocalSide += spow; bandPow += mp + spow; }
        else if (f >= 4300 && f < 12000) { highMid += mp; highSide += spow; }
        totalPow += mp + spow;
      }
    }

    var frames = 0;
    for (var off = start; off + N < L.length && frames < maxFrames; off += hop) {
      addFrame(off);
      frames++;
    }
    if (!frames) { return { stereo: stereo, centerRatio: 0, bandFocus: 0, strategy: stereo ? "center" : "mono", clarity: 50 }; }

    var centerRatio = (vocalMid + vocalSide) > 0 ? vocalMid / (vocalMid + vocalSide) : 0;
    var bandFocus = totalPow > 0 ? bandPow / totalPow : 0;

    var strategy, clarity;
    if (!stereo) {
      strategy = "mono";
      clarity = Math.round(35 + 35 * Math.min(1, Math.max(0, (bandFocus - 0.12) / 0.3)));
    } else if (centerRatio >= 0.62) {
      strategy = "center";
      clarity = Math.round(58 + 42 * Math.min(1, Math.max(0, (centerRatio - 0.62) / 0.35)));
    } else if (centerRatio >= 0.4) {
      strategy = "blend";
      clarity = Math.round(42 + 38 * Math.min(1, Math.max(0, (centerRatio - 0.4) / 0.22)));
    } else {
      strategy = "band";
      clarity = Math.round(30 + 28 * Math.min(1, Math.max(0, (centerRatio - 0.15) / 0.25)));
    }
    return {
      stereo: stereo,
      centerRatio: centerRatio,
      bandFocus: bandFocus,
      lowMid: lowMid, lowSide: lowSide,
      vocalMid: vocalMid, vocalSide: vocalSide,
      highMid: highMid, highSide: highSide,
      strategy: strategy,
      clarity: clarity
    };
  }

  var STRATEGY_LABELS = {
    center: "center extraction",
    blend: "center blend",
    band: "frequency focus",
    mono: "mono frequency focus"
  };

  /* Profile used while the FFT analysis of a new song is still running. */
  function effectiveProfile(song, buf) {
    if (song && song._profile) return song._profile;
    var stereo = !!(buf && buf.numberOfChannels >= 2);
    return {
      stereo: stereo,
      strategy: stereo ? "center" : "mono",
      centerRatio: 0.7, bandFocus: 0.3, clarity: 70
    };
  }

  /* ============================================================
     Audio engine
     Chain: source -> (stems -> mix -> comp) | (original: eqIn)
            -> 5-band EQ -> master -> analyser -> destination
     ============================================================ */
  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null, master = null, analyser = null, comp = null, mix = null, eqIn = null;
  var eqBands = [];
  var buffer = null, source = null, graphV = null, graphI = null;
  var mode = "original";
  /* Auto Purify — every song is analyzed automatically and its music
     (instruments) is removed automatically: playback starts on the
     vocals-only stem. The listener can still switch modes any time. */
  var autoPurify = true;
  var playing = false;
  var startCtxTime = 0, offsetBase = 0, duration = 0;
  var playbackRate = 1, volume = 80, muted = false;
  var stemV = 100, stemI = 100;
  var muteV = false, muteI = false, soloV = false, soloI = false;
  var customMem = { v: 70, i: 70 };
  var freqData = null;
  var exporting = false;

  var ICON_PLAY = "M7.5 4.8v14.4L20 12z";
  var ICON_PAUSE = "M6.5 4h3.6v16H6.5zM13.9 4h3.6v16h-3.6z";

  /* ---- shared node builders (realtime + offline export) ---- */
  function cGain(C, v) { var g = C.createGain(); g.gain.value = v; return g; }
  function cFilter(C, type, freq, q) {
    var f = C.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    f.Q.value = (q === undefined ? 0.71 : q);
    return f;
  }
  function cComp(C) {
    var c = C.createDynamicsCompressor();
    c.threshold.value = -10; c.knee.value = 10; c.ratio.value = 4;
    c.attack.value = 0.005; c.release.value = 0.16;
    return c;
  }
  /* stereo helpers: mono mid = (L+R)/2, mono side = (L-R)/2 */
  function monoMid(C, src) {
    var sp = C.createChannelSplitter(2), gL = cGain(C, 0.5), gR = cGain(C, 0.5);
    var m = C.createChannelMerger(2);
    src.connect(sp);
    sp.connect(gL, 0); sp.connect(gR, 1);
    gL.connect(m, 0, 0); gR.connect(m, 0, 0);
    return m;
  }
  function monoSide(C, src) {
    var sp = C.createChannelSplitter(2), a = cGain(C, 0.5), b = cGain(C, -0.5);
    var m = C.createChannelMerger(2);
    src.connect(sp);
    sp.connect(a, 0); sp.connect(b, 1);
    a.connect(m, 0, 0); b.connect(m, 0, 0);
    return m;
  }

  /**
   * Builds BOTH stems from `src` into `outV` / `outI` for the given
   * analysis profile. Returns { vocal, music } terminal nodes.
   */
  function buildStems(C, src, profile, outV, outI) {
    var stereo = profile && profile.stereo;
    var strat = (profile && profile.strategy) || (stereo ? "center" : "mono");
    var vEnd, iEnd;

    if (stereo) {
      var mid = monoMid(C, src);
      var side = monoSide(C, src);

      /* ---- vocal stem ---- */
      if (strat === "center" || strat === "blend") {
        var centerSum = cGain(C, 1);
        var body = cFilter(C, "highpass", 85), bodyLp = cFilter(C, "lowpass", 300), bodyG = cGain(C, 0.4);
        var core = cFilter(C, "highpass", 280), coreLp = cFilter(C, "lowpass", 5200), coreG = cGain(C, 1.0);
        var air = cFilter(C, "highpass", 5200), airLp = cFilter(C, "lowpass", 12500), airG = cGain(C, 0.7);
        mid.connect(body); body.connect(bodyLp); bodyLp.connect(bodyG); bodyG.connect(centerSum);
        mid.connect(core); core.connect(coreLp); coreLp.connect(coreG); coreG.connect(centerSum);
        mid.connect(air); air.connect(airLp); airLp.connect(airG); airG.connect(centerSum);
        var vocalIn;
        if (strat === "blend") {
          /* wide reverb tails live in the side signal — bring some back,
             duck the center part so the mix stays voice-forward */
          var sumV = cGain(C, 1);
          var duck = cGain(C, 0.75);
          var tail = cFilter(C, "lowpass", 8000), tailG = cGain(C, 0.3);
          centerSum.connect(duck); duck.connect(sumV);
          side.connect(tail); tail.connect(tailG); tailG.connect(sumV);
          vocalIn = sumV;
        } else {
          vocalIn = centerSum;
        }
        var presence = cFilter(C, "peaking", 2700, 1.1); presence.gain.value = 2.5;
        vocalIn.connect(presence);
        vEnd = cComp(C);
        presence.connect(vEnd);
        var vMake = cGain(C, 1.15);
        vEnd.connect(vMake); vMake.connect(outV);
      } else {
        /* band / weak-center: treat as focused mono */
        var vHp = cFilter(C, "highpass", 140);
        var vPk = cFilter(C, "peaking", 2000, 0.9); vPk.gain.value = 2;
        var vLp = cFilter(C, "lowpass", 5200);
        mid.connect(vHp); vHp.connect(vPk); vPk.connect(vLp);
        vEnd = cComp(C);
        vLp.connect(vEnd);
        var vMake2 = cGain(C, 1.25);
        vEnd.connect(vMake2); vMake2.connect(outV);
      }

      /* ---- music stem ---- */
      var sumI = cGain(C, 1);
      var sideOut = cFilter(C, "highpass", 150), sideG = cGain(C, 1.3);
      side.connect(sideOut); sideOut.connect(sideG);
      var bass = cFilter(C, "lowpass", 150), bassG = cGain(C, 0.95);
      mid.connect(bass); bass.connect(bassG);
      var mBody = cFilter(C, "highpass", 150), mBodyLp = cFilter(C, "lowpass", 420), mBodyG = cGain(C, 0.35);
      mid.connect(mBody); mBody.connect(mBodyLp); mBodyLp.connect(mBodyG);
      if (strat === "blend") {
        /* keep a bit of the full mid so wide mixes don't go empty;
           duck the vocal band out of it */
        var mDuck = cFilter(C, "peaking", 2400, 0.8); mDuck.gain.value = -5;
        var mRet = cGain(C, 0.15);
        mid.connect(mDuck); mDuck.connect(mRet);
        sideG.connect(sumI); bassG.connect(sumI); mBodyG.connect(sumI); mRet.connect(sumI);
      } else {
        sideG.connect(sumI); bassG.connect(sumI); mBodyG.connect(sumI);
      }
      iEnd = cComp(C);
      sumI.connect(iEnd);
      var iMake = cGain(C, 1.0);
      iEnd.connect(iMake); iMake.connect(outI);
    } else {
      /* ---- mono track: no side signal exists ---- */
      var mHp = cFilter(C, "highpass", 140);
      var mPk = cFilter(C, "peaking", 1900, 0.9); mPk.gain.value = 3.5;
      var mLp = cFilter(C, "lowpass", 5200);
      src.connect(mHp); mHp.connect(mPk); mPk.connect(mLp);
      vEnd = cComp(C);
      mLp.connect(vEnd);
      var vMake = cGain(C, 1.35);
      vEnd.connect(vMake); vMake.connect(outV);

      var iLo = cFilter(C, "lowpass", 140), iLoG = cGain(C, 1.15);
      var iHi = cFilter(C, "highpass", 5200), iHiG = cGain(C, 1.15);
      var iSum = cGain(C, 1);
      var iPk2 = cFilter(C, "peaking", 2500, 0.7); iPk2.gain.value = -4;
      src.connect(iLo); iLo.connect(iLoG); iLoG.connect(iSum);
      src.connect(iHi); iHi.connect(iHiG); iHiG.connect(iSum);
      iSum.connect(iPk2);
      iEnd = cComp(C);
      iPk2.connect(iEnd);
      var iMake = cGain(C, 1.1);
      iEnd.connect(iMake); iMake.connect(outI);
    }
    return { vocal: vEnd, music: iEnd, strategy: strat };
  }

  function ensureCtx() {
    if (!AC) return false;
    if (!actx) {
      try { actx = new AC(); } catch (e) { return false; }
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
    syncVolumeUI();
  }
  function syncVolumeUI() {
    var sv = $("set-volume");
    if (sv) sv.value = String(volume);
    var svv = $("set-volume-val");
    if (svv) svv.textContent = Math.round(volume) + "%";
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
      try { source.stop(0); } catch (e) { /* ignore */ }
      try { source.disconnect(); } catch (e) { /* ignore */ }
      source = null;
    }
    if (graphV) { try { graphV.disconnect(); } catch (e) { /* ignore */ } graphV = null; }
    if (graphI) { try { graphI.disconnect(); } catch (e) { /* ignore */ } graphI = null; }
  }

  function startAt(offset) {
    if (!buffer || !actx) return;
    if (actx.state === "suspended") {
      actx.resume().catch(function () { /* ignore */ });
    }
    stopSource();
    offset = Math.max(0, Math.min(offset, Math.max(duration - 0.05, 0)));
    source = actx.createBufferSource();
    source.buffer = buffer;
    try { source.playbackRate.value = playbackRate; } catch (e) { /* ignore */ }

    var song = currentSong();
    var profile = effectiveProfile(song, buffer);
    if (mode === "original") {
      source.connect(eqIn);
    } else {
      /* Both stems are always built; effStem() zeroes the unused one so a
         single-stem mode (vocals / karaoke) is exact and switching is free.
         Crucial: connect both stem outputs into mix bus! */
      graphV = actx.createGain();
      graphI = actx.createGain();
      buildStems(actx, source, profile, graphV, graphI);
      graphV.connect(mix);
      graphI.connect(mix);
      applyStemGains();
    }
    source.onended = function () {
      if (!playing) return;
      if (currentPos() >= duration - 0.25) onTrackEnded();
    };
    try { source.start(0, offset); }
    catch (e) {
      playing = false;
      setPlayIcon(false);
      toast("Playback failed — try another song.", "error");
      return;
    }
    offsetBase = offset;
    startCtxTime = actx.currentTime;
    playing = true;
    setPlayIcon(true);
    updateNpArt();
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
  }

  function togglePlay() {
    if (!buffer) {
      var ids = currentViewIds.length ? currentViewIds.slice() : library.map(function (s) { return s.id; });
      if (!ids.length) { toast("Add songs first — tap ＋ in the top bar."); return; }
      playFromList(ids, 0);
      return;
    }
    if (!ensureCtx()) return;
    if (playing) pausePlayback();
    else startAt(currentPos() >= duration - 0.1 ? 0 : currentPos());
  }

  /* ---------------- queue ---------------- */
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
    if (!ensureCtx()) { toast("Audio is not supported on this device.", "error"); return; }
    var my = ++loadToken;
    currentId = id;
    markCurrentRow(); renderQueue(); updateNp();
    getBuffer(song).then(function (buf) {
      if (my !== loadToken) return;
      stopPlayback();
      buffer = buf;
      duration = buf.duration || 0;
      offsetBase = 0;
      if (song.duration !== duration) { song.duration = duration; idbPut(cleanRec(song)); }
      $("np-title").textContent = song.title;
      $("np-artist").textContent = song.artist + " · " + (buf.numberOfChannels >= 2 ? "stereo" : "mono");
      updateNpArt();
      updateProgressUI();
      drawViz();
      markCurrentRow(); renderQueue(); updateNp();
      updateEngineLine();
      /* Auto Purify: music is removed automatically for every new track */
      applyAutoMode();
      if (autoplay) { startAt(0); openNp(); }
      /* run the analyzer (once per song, result persisted) */
      if (!song._profile) {
        setTimeout(function () {
          try {
            var p = analyzeBuffer(buf);
            if (my !== loadToken) return;
            song._profile = p;
            idbPut(cleanRec(song));
            updateEngineLine();
            renderHome(); renderSearch();
            if (playing && mode !== "original") startAt(currentPos());
          } catch (e) { /* keep default strategy */ }
        }, 300);
      }
    }).catch(function () {
      if (my !== loadToken) return;
      toast("Could not play “" + song.title + "” — file may be corrupt.", "error");
    });
  }

  function decodeArrayBuffer(ab) {
    return new Promise(function (resolve, reject) {
      if (!ensureCtx()) {
        reject(new Error("AudioContext not supported"));
        return;
      }
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

  function loadFromDevicePath(song, resolve, reject) {
    var url = "https://vocalpure.local/audio?path=" + encodeURIComponent(song.path);
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("fetch: " + res.status);
        return res.arrayBuffer();
      })
      .then(function (ab) {
        return decodeArrayBuffer(ab);
      })
      .then(function (b) {
        cacheBuffer(song, b);
        resolve(b);
      })
      .catch(function (fetchErr) {
        // Fallback: try native bridge readAudioBase64
        if (window.VocalPureAndroid && window.VocalPureAndroid.readAudioBase64) {
          try {
            var b64Data = window.VocalPureAndroid.readAudioBase64(song.path);
            if (b64Data && b64Data.length > 0) {
              var binary = atob(b64Data);
              var len = binary.length;
              var bytes = new Uint8Array(len);
              for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
              decodeArrayBuffer(bytes.buffer).then(function (b) {
                cacheBuffer(song, b);
                resolve(b);
              }, reject);
              return;
            }
          } catch (bridgeErr) { /* ignore */ }
        }
        reject(fetchErr || new Error("Failed to load device audio"));
      });
  }

  function getBuffer(song) {
    return new Promise(function (resolve, reject) {
      if (song._buffer) { resolve(song._buffer); return; }
      if (!ensureCtx()) { reject(new Error("AudioContext unavailable")); return; }

      // 1. If song has a blob (uploaded or imported via file picker)
      if (song.blob) {
        var blob = song.blob;
        function onAb(ab) {
          decodeArrayBuffer(ab).then(function (b) { cacheBuffer(song, b); resolve(b); }, reject);
        }
        try {
          if (blob.arrayBuffer) {
            blob.arrayBuffer().then(onAb).catch(function () {
              if (song.path) loadFromDevicePath(song, resolve, reject);
              else reject(new Error("read"));
            });
            return;
          } else {
            var r = new FileReader();
            r.onload = function () { onAb(r.result); };
            r.onerror = function () {
              if (song.path) loadFromDevicePath(song, resolve, reject);
              else reject(new Error("read"));
            };
            r.readAsArrayBuffer(blob);
            return;
          }
        } catch (e) {
          if (song.path) loadFromDevicePath(song, resolve, reject);
          else reject(e);
          return;
        }
      }

      // 2. If song is a device file with path
      if (song.path) {
        loadFromDevicePath(song, resolve, reject);
        return;
      }

      reject(new Error("no data"));
    });
  }

  function onTrackEnded() {
    if (repeatMode === "one") { startAt(0); return; }
    if (qi >= 0 && qi < queue.length - 1) { qi++; loadSongById(queue[qi], true); return; }
    if (repeatMode === "all" && queue.length) { qi = 0; loadSongById(queue[qi], true); return; }
    playing = false; offsetBase = 0;
    setPlayIcon(false); updateProgressUI();
  }

  function stepNext() {
    if (!queue.length) { toast("Nothing in the queue yet."); return; }
    qi = (qi + 1) % queue.length;
    loadSongById(queue[qi], true);
  }
  function stepPrev() {
    if (buffer && currentPos() > 3) { startAt(0); return; }
    if (!queue.length) { toast("Nothing in the queue yet."); return; }
    qi = (qi - 1 + queue.length) % queue.length;
    loadSongById(queue[qi], true);
  }

  /* ============================================================
     Isolation UI
     ============================================================ */
  var MODE_NAMES = { original: "Original", vocals: "🎤 Vocals", karaoke: "🎶 Karaoke", custom: "🎚 My mix" };

  function updateEngineLine() {
    var song = currentSong();
    var p = song ? song._profile : null;

    /* clarity ring + strategy card on the Now Playing screen */
    var card = $("np-engine-card");
    if (card) card.classList.toggle("is-analyzing", !!song && !p);
    var ring = $("np-clarity-ring"), num = $("np-clarity-num");
    if (ring && num) {
      if (p) {
        ring.style.background = "conic-gradient(var(--accent) " + Math.round(p.clarity * 3.6) + "deg, rgba(255,255,255,0.08) 0deg)";
        num.textContent = p.clarity + "%";
      } else {
        ring.style.background = "conic-gradient(rgba(255,255,255,0.08) 0deg, rgba(255,255,255,0.08) 360deg)";
        num.textContent = song ? "…" : "–";
      }
    }
    var stratEl = $("np-strategy"), detailEl = $("np-strategy-detail");
    if (stratEl && detailEl) {
      if (!song) {
        stratEl.textContent = "Auto purify engine";
        detailEl.textContent = "Add songs — they are analyzed automatically, then their music is removed.";
      } else if (!p) {
        stratEl.textContent = "Analyzing automatically…";
        detailEl.textContent = "Measuring the stereo image to pick the strongest isolation strategy.";
      } else {
        var lbl = STRATEGY_LABELS[p.strategy] || "isolation";
        stratEl.textContent = lbl.charAt(0).toUpperCase() + lbl.slice(1) +
          (autoPurify && mode === "vocals" ? " · music auto-removed" : "");
        detailEl.textContent = p.stereo
          ? Math.round(p.centerRatio * 100) + "% of the vocal band is center-locked · est. clarity " + p.clarity + "%"
          : "Mono file — frequency focus · est. clarity " + p.clarity + "%";
      }
    }

    var el = $("engine-line");
    if (!el) return;
    if (!song) { el.innerHTML = "Every song is <b>analyzed automatically</b> on import — the engine picks the strongest strategy per track."; return; }
    if (autoPurify && mode === "vocals") { el.innerHTML = "Auto purify is on — the music track was <b>removed automatically</b>; only the pure voice plays. Switch modes above any time."; return; }
    if (mode === "original") { el.innerHTML = "Original mix — untouched audio. Pick a mode above to isolate."; return; }
    if (!p) { el.innerHTML = "Analyzing stereo balance… first playback uses the best-guess strategy."; return; }
    var strategy = STRATEGY_LABELS[p.strategy] || "isolation";
    var detail = p.stereo
      ? Math.round(p.centerRatio * 100) + "% of the vocal band is center-locked"
      : "mono file — frequency focus applied";
    el.innerHTML = "Strategy: <b>" + strategy + "</b> · " + detail + " · est. clarity <b>" + p.clarity + "%</b>";
  }

  var modeBtns = Array.prototype.slice.call(document.querySelectorAll(".mode-btn"));
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
    updateNp();
    saveSettings();
    if (buffer && playing && (changed || opts.rebuild)) startAt(currentPos());
    else if (buffer) applyStemGains();
    updateEngineLine();
  }

  function ensureCustomMix() {
    if (mode !== "custom") setMode("custom", {});
  }

  /**
   * Auto Purify: silently move to the vocals-only stem when a fresh track
   * is loaded (called before startAt, so no rebuild is needed). Keeps the
   * mode buttons in sync. Returns true when it applied.
   */
  function applyAutoMode() {
    if (!autoPurify || mode === "vocals") return false;
    if (mode === "custom") { customMem.v = stemV; customMem.i = stemI; }
    mode = "vocals";
    stemV = 100; stemI = 0;
    for (var k = 0; k < modeBtns.length; k++) {
      modeBtns[k].classList.toggle("is-active", modeBtns[k].getAttribute("data-mode") === "vocals");
    }
    updateStemUI();
    updateNp();
    updateEngineLine();
    saveSettings();
    return true;
  }

  function syncModeButtons() {
    for (var k = 0; k < modeBtns.length; k++) {
      modeBtns[k].classList.toggle("is-active", modeBtns[k].getAttribute("data-mode") === mode);
    }
  }

  function updateAutoUI() {
    var sw = $("set-autopurify");
    if (sw) {
      sw.classList.toggle("is-on", autoPurify);
      sw.setAttribute("aria-checked", autoPurify ? "true" : "false");
    }
    var pill = $("auto-pill");
    if (pill) pill.hidden = !autoPurify;
  }

  function updateStemUI() {
    var sv = $("stem-vocal"), si = $("stem-music");
    if (sv) sv.value = String(Math.round(stemV));
    if (si) si.value = String(Math.round(stemI));
    var svv = $("stem-vocal-val"), siv = $("stem-music-val");
    if (svv) svv.textContent = Math.round(stemV) + "%";
    if (siv) siv.textContent = Math.round(stemI) + "%";
    var mv = $("mute-vocal"), mi = $("mute-music"), soV = $("solo-vocal"), soI = $("solo-music");
    if (mv) mv.classList.toggle("is-off", muteV);
    if (mi) mi.classList.toggle("is-off", muteI);
    if (soV) soV.classList.toggle("is-off", soloV);
    if (soI) soI.classList.toggle("is-off", soloI);
    var cv = $("card-vocal"), ci = $("card-music");
    if (cv) cv.classList.toggle("stem-muted", effStem("v") <= 0.001);
    if (ci) ci.classList.toggle("stem-muted", effStem("i") <= 0.001);
  }

  /* ============================================================
     Equalizer
     ============================================================ */
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
      var b = $("eq-" + i), v = $("eq-val-" + i);
      if (b) b.value = String(eqGains[i]);
      if (v) v.textContent = (eqGains[i] > 0 ? "+" : "") + eqGains[i] + " dB";
    }
    var sel = $("eq-preset");
    if (sel) sel.value = EQ_PRESETS[eqPresetName] ? eqPresetName : "custom";
    var sw = $("eq-on");
    if (sw) {
      sw.classList.toggle("is-on", eqOn);
      sw.setAttribute("aria-checked", eqOn ? "true" : "false");
    }
  }

  /* ============================================================
     Sleep timer
     ============================================================ */
  var sleepAt = 0;
  function sleepLabel() {
    if (!sleepAt) return "";
    var left = Math.max(0, sleepAt - Date.now());
    var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    return "Sleep: stops in " + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function fadeAndPause() {
    if (!actx || !playing) { pausePlayback(); return; }
    try {
      master.gain.cancelScheduledValues(actx.currentTime);
      master.gain.setTargetAtTime(0.0001, actx.currentTime, 0.4);
    } catch (e) { /* ignore */ }
    setTimeout(function () { pausePlayback(); applyVolume(); }, 1600);
  }

  /* ============================================================
     Visualizer
     ============================================================ */
  var vizCanvas = $("np-viz");
  var vizCtx = null;
  try { vizCtx = vizCanvas ? vizCanvas.getContext("2d") : null; } catch (e) { vizCtx = null; }
  var vizW = 0, vizH = 64, vizRaf = null;

  function sizeViz() {
    if (!vizCanvas || !vizCtx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    vizW = vizCanvas.clientWidth || 340;
    vizH = vizCanvas.clientHeight || 64;
    vizCanvas.width = Math.floor(vizW * dpr);
    vizCanvas.height = Math.floor(vizH * dpr);
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawIdleViz(t) {
    if (!vizCtx) return;
    vizCtx.clearRect(0, 0, vizW, vizH);
    vizCtx.beginPath();
    var mid = vizH / 2;
    for (var x = 0; x <= vizW; x += 4) {
      var y = mid + Math.sin(x * 0.02 + t / 500) * 8 * Math.sin(x * 0.005 + t / 900);
      if (x === 0) vizCtx.moveTo(x, y); else vizCtx.lineTo(x, y);
    }
    var g = vizCtx.createLinearGradient(0, 0, vizW, 0);
    g.addColorStop(0, "#2fe6c8");
    g.addColorStop(1, "#3aa6ff");
    vizCtx.strokeStyle = g;
    vizCtx.lineWidth = 2;
    vizCtx.globalAlpha = 0.6;
    vizCtx.stroke();
    vizCtx.globalAlpha = 1;
  }

  function drawViz() {
    if (!vizCtx) return;
    if (!analyser || !playing || !freqData) { drawIdleViz(performance.now()); return; }
    analyser.getByteFrequencyData(freqData);
    vizCtx.clearRect(0, 0, vizW, vizH);
    var n = 40, step = Math.floor(freqData.length / n) || 1;
    var bw = vizW / n;
    var g = vizCtx.createLinearGradient(0, vizH, 0, 0);
    g.addColorStop(0, "#2fe6c8");
    g.addColorStop(1, "#3aa6ff");
    vizCtx.fillStyle = g;
    for (var i = 0; i < n; i++) {
      var v = freqData[i * step] / 255;
      var h = Math.max(3, v * (vizH - 8));
      var x = i * bw + bw * 0.18;
      vizCtx.fillRect(x, vizH - h, bw * 0.64, h);
    }
  }

  function startVizLoop() {
    if (vizRaf) return;
    var loop = function () {
      drawViz();
      updateProgressUI();
      if (playing) vizRaf = requestAnimationFrame(loop);
      else { vizRaf = null; drawViz(); }
    };
    vizRaf = requestAnimationFrame(loop);
  }

  function updateProgressUI() {
    var pos = currentPos();
    var pct = duration > 0 ? (pos / duration) * 100 : 0;
    var fill = $("np-progress-fill");
    if (fill) fill.style.width = pct.toFixed(2) + "%";
    var cur = $("np-time-cur"), tot = $("np-time-total");
    if (cur) cur.textContent = fmtTime(pos);
    if (tot) tot.textContent = fmtTime(duration);
    var prog = $("np-progress");
    if (prog) prog.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  function seekTo(ratio) {
    if (!buffer || duration <= 0) return;
    ratio = Math.max(0, Math.min(1, ratio));
    var pos = ratio * duration;
    if (playing) startAt(pos);
    else { offsetBase = pos; updateProgressUI(); }
  }

  /* ============================================================
     Rendering — lists
     ============================================================ */
  function coverStyle(title) {
    var hue = coverHue(title);
    return "background:linear-gradient(135deg,hsl(" + hue + ",62%,52%),hsl(" + ((hue + 45) % 360) + ",62%,38%))";
  }

  function attachRowActions(listEl) {
    listEl.addEventListener("click", function (e) {
      var li = e.target.closest ? e.target.closest("li.song-row") : null;
      if (!li) return;
      var id = li.getAttribute("data-id");
      var btn = e.target.closest ? e.target.closest("button.row-btn") : null;
      if (btn) {
        if (btn.classList.contains("fav-btn")) { toggleFav(id); return; }
        if (btn.classList.contains("add-btn")) { openPlSheet(id, btn); return; }
        if (btn.classList.contains("del-btn")) { removeSong(id); return; }
        return;
      }
      var main = e.target.closest ? e.target.closest("button.song-main") : null;
      if (!main) return;
      var ids = listEl._viewIds || [];
      var at = ids.indexOf(id);
      playFromList(ids.slice(), at >= 0 ? at : 0);
    });
  }

  /* One song row. opts.fav / opts.add / opts.del toggle row action buttons. */
  function songRowHtml(s, opts) {
    opts = opts || {};
    var dur = s.duration > 0 ? fmtTime(s.duration) : "–:––";
    var autoFlag = s._profile ? ' <em class="row-auto">✓ auto</em>' : "";
    var isCur = s.id === currentId;
    var html = '<li class="song-row' + (isCur ? " is-current" + (playing ? "" : " is-paused") : "") + '" data-id="' + escapeHtml(s.id) + '">' +
      '<button type="button" class="song-main" aria-label="Play ' + escapeHtml(s.title) + '">' +
      '<span class="song-cover" style="' + coverStyle(s.title) + '" aria-hidden="true">' + escapeHtml(coverLetter(s.title)) + "</span>" +
      '<span class="song-meta"><strong>' + escapeHtml(s.title) + "</strong><span>" + escapeHtml(s.artist) + " · " + dur + autoFlag + "</span></span>" +
      '<span class="song-live" aria-hidden="true"><i></i><i></i><i></i></span>' +
      "</button>";
    if (opts.fav) html += '<button type="button" class="row-btn fav-btn' + (s.favorite ? " is-fav" : "") + '" aria-label="Toggle favorite">' + (s.favorite ? "★" : "☆") + "</button>";
    if (opts.add) html += '<button type="button" class="row-btn add-btn" aria-label="Add to playlist">＋</button>';
    if (opts.del) html += '<button type="button" class="row-btn del-btn" aria-label="Remove">✕</button>';
    return html + "</li>";
  }

  function renderHome() {
    var listEl = $("home-list");
    var empty = $("home-empty");
    if (!listEl) return;
    prunePlaylists();
    var songs = viewHome();
    var html = "";
    for (var i = 0; i < songs.length; i++) html += songRowHtml(songs[i], { fav: true, add: true, del: true });
    listEl.innerHTML = html;
    listEl._viewIds = songs.map(function (s) { return s.id; });
    if (empty) empty.hidden = !!songs.length;
    var pa = $("btn-play-all");
    if (pa) pa.disabled = !songs.length;
    updateCounts();
  }

  function renderSearch() {
    var listEl = $("search-list");
    var empty = $("search-empty");
    var count = $("search-count");
    if (!listEl) return;
    var songs = viewSearch();
    var html = "";
    for (var i = 0; i < songs.length; i++) html += songRowHtml(songs[i], { fav: true, add: true });
    listEl.innerHTML = html;
    listEl._viewIds = songs.map(function (s) { return s.id; });
    if (empty) empty.hidden = !!(searchQuery && songs.length);
    if (count) count.textContent = searchQuery ? (songs.length + " match" + (songs.length === 1 ? "" : "es")) : "";
  }

  function renderPlaylists() {
    var grid = $("playlist-list");
    var empty = $("playlists-empty");
    if (!grid) return;
    prunePlaylists();
    var html = "";
    for (var i = 0; i < playlists.length; i++) {
      var p = playlists[i];
      html += '<div class="pl-card">' +
        '<button type="button" class="pl-card-main" data-pl="' + escapeHtml(p.id) + '">' +
        '<span class="pl-cover" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M4 12h12M4 18h7"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M21.5 18.5V9l-3-1"/></svg>' +
        "</span>" +
        '<span class="pl-meta"><strong>' + escapeHtml(p.name) + "</strong><span>" + p.songIds.length + " song" + (p.songIds.length === 1 ? "" : "s") + "</span></span>" +
        "</button>" +
        '<button type="button" class="row-btn" data-pl-play="' + escapeHtml(p.id) + '" aria-label="Play playlist">▶</button>' +
        "</div>";
    }
    grid.innerHTML = html;
    if (empty) empty.hidden = !!playlists.length;
    grid.onclick = function (e) {
      var playBtn = e.target.closest ? e.target.closest("[data-pl-play]") : null;
      if (playBtn) {
        var p2 = playlists.filter(function (x) { return x.id === playBtn.getAttribute("data-pl-play"); })[0];
        if (p2 && p2.songIds.length) playFromList(p2.songIds.slice(), 0);
        else toast("“" + (p2 ? p2.name : "Playlist") + "” is empty — add songs first.");
        return;
      }
      var main = e.target.closest ? e.target.closest("[data-pl]") : null;
      if (main) openPlaylist(main.getAttribute("data-pl"));
    };
  }

  function openPlaylist(id) {
    var p = playlists.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    openPlaylistId = id;
    $("pl-name").textContent = p.name;
    renderPlaylistSongs();
    showScreen("playlist");
  }

  function renderPlaylistSongs() {
    var listEl = $("playlist-songs");
    var empty = $("playlist-empty");
    if (!listEl || !openPlaylistId) return;
    var p = playlists.filter(function (x) { return x.id === openPlaylistId; })[0];
    if (!p) return;
    var songs = p.songIds.map(songById).filter(Boolean);
    var html = "";
    for (var i = 0; i < songs.length; i++) {
      html += songRowHtml(songs[i], {}).replace(
        "</li>",
        '<button type="button" class="row-btn" data-pl-rm="' + escapeHtml(songs[i].id) + '" aria-label="Remove from playlist">✕</button></li>'
      );
    }
    listEl.innerHTML = html;
    listEl._viewIds = songs.map(function (s) { return s.id; });
    $("pl-count").textContent = songs.length + " song" + (songs.length === 1 ? "" : "s");
    if (empty) empty.hidden = !!songs.length;
    listEl.onclick = function (e) {
      var rm = e.target.closest ? e.target.closest("[data-pl-rm]") : null;
      if (rm) {
        p.songIds = p.songIds.filter(function (x) { return x !== rm.getAttribute("data-pl-rm"); });
        savePlaylists(); renderPlaylistSongs(); renderPlaylists();
        return;
      }
      var li = e.target.closest ? e.target.closest("li.song-row") : null;
      if (!li) return;
      var id = li.getAttribute("data-id");
      var at = p.songIds.indexOf(id);
      playFromList(p.songIds.slice(), at >= 0 ? at : 0);
    };
  }

  function markCurrentRow() {
    var all = document.querySelectorAll("li.song-row");
    for (var i = 0; i < all.length; i++) {
      var isCur = all[i].getAttribute("data-id") === currentId;
      all[i].classList.toggle("is-current", isCur);
      all[i].classList.toggle("is-paused", isCur && !playing);
    }
  }

  function updateCounts() {
    var n = library.length;
    var total = 0;
    for (var i = 0; i < n; i++) total += (library[i].blob && library[i].blob.size) || 0;
    var sc = $("set-song-count"), ss = $("set-storage");
    if (sc) sc.textContent = String(n);
    if (ss) ss.textContent = fmtSize(total);
  }

  function toggleFav(id) {
    var s = songById(id);
    if (!s) return;
    s.favorite = !s.favorite;
    idbPut(cleanRec(s));
    renderHome(); renderSearch(); updateNp();
    if (s.favorite) toast("“" + s.title + "” added to favorites.", "success");
  }

  function removeSong(id) {
    var s = songById(id);
    if (!s) return;
    var wasCurrent = (id === currentId);
    if (wasCurrent) {
      stopPlayback();
      buffer = null; currentId = null; duration = 0; offsetBase = 0;
      $("np-title").textContent = "Nothing playing";
      $("np-artist").textContent = "Add songs to get started";
      updateProgressUI(); drawViz();
    }
    library = library.filter(function (x) { return x.id !== id; });
    idbDel(id);
    for (var p = 0; p < playlists.length; p++) {
      playlists[p].songIds = playlists[p].songIds.filter(function (x) { return x !== id; });
    }
    savePlaylists();
    queue = queue.filter(function (x) { return x !== id; });
    if (qi >= queue.length) qi = Math.max(-1, queue.length - 1);
    renderHome(); renderSearch(); renderPlaylists(); renderQueue();
    if (openPlaylistId) renderPlaylistSongs();
    updateCounts(); updateNp();
    toast("Removed “" + s.title + "”.");
  }

  /* ============================================================
     Now Playing UI
     ============================================================ */
  var npScreen = $("np-screen");

  function openNp() {
    if (!npScreen) return;
    npScreen.hidden = false;
    sizeViz();
  }
  function closeNp() {
    if (!npScreen) return;
    npScreen.hidden = true;
  }

  function setPlayIcon(isPlaying) {
    var icon = $("np-play-icon");
    if (icon) {
      while (icon.firstChild) icon.removeChild(icon.firstChild);
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", isPlaying ? ICON_PAUSE : ICON_PLAY);
      icon.appendChild(p);
    }
    var btn = $("btn-play");
    if (btn) btn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    updateNp();
  }

  function updateNpArt() {
    var s = currentSong();
    var art = $("np-art"), letter = $("np-art-letter");
    if (!art || !letter) return;
    if (!s) { art.style.background = "var(--surface-2)"; letter.textContent = "♪"; return; }
    var hue = coverHue(s.title);
    art.style.background = "linear-gradient(135deg, hsl(" + hue + ",62%,50%), hsl(" + ((hue + 50) % 360) + ",64%,34%))";
    letter.textContent = coverLetter(s.title);
  }

  function updateNp() {
    var s = currentSong();
    var chip = $("np-mode-chip");
    if (chip) chip.textContent = s ? ((MODE_NAMES[mode] || mode) + (autoPurify && mode === "vocals" ? " · auto" : "")) : "—";
    var fav = $("np-fav");
    if (fav) fav.classList.toggle("is-fav", !!(s && s.favorite));
    var play = $("btn-play");
    if (play) play.disabled = !s;
    var stems = ["stem-vocal", "stem-music", "mute-vocal", "mute-music", "solo-vocal", "solo-music",
      "exp-vocals", "exp-karaoke", "exp-mix"];
    for (var i = 0; i < stems.length; i++) {
      var el = $(stems[i]);
      if (el) el.disabled = !s;
    }
    for (var m = 0; m < modeBtns.length; m++) modeBtns[m].disabled = !s;
  }

  function renderQueue() {
    var listEl = $("queue-list");
    var cnt = $("queue-count");
    if (!listEl) return;
    if (cnt) cnt.textContent = queue.length ? "(" + queue.length + ")" : "";
    if (!queue.length) {
      listEl.innerHTML = '<li class="queue-empty">Queue is empty — tap any song to start playing.</li>';
      return;
    }
    var html = "";
    for (var k = 0; k < queue.length; k++) {
      var s = songById(queue[k]);
      if (!s) continue;
      html += '<li class="queue-row' + (k === qi ? " is-current" : "") + (k < qi ? " is-past" : "") + '">' +
        '<button type="button" class="queue-main" data-q="' + k + '" aria-label="Play ' + escapeHtml(s.title) + '">' +
        '<span class="queue-num">' + (k === qi ? "▶" : (k + 1)) + "</span>" +
        '<span class="queue-meta"><strong>' + escapeHtml(s.title) + "</strong><span>" + escapeHtml(s.artist) + " · " + (s.duration > 0 ? fmtTime(s.duration) : "–:––") + "</span></span>" +
        "</button></li>";
    }
    listEl.innerHTML = html;
  }

  /* ============================================================
     Playlist picker sheet
     ============================================================ */
  var plSheetSongId = null;
  function openPlSheet(songId, anchor) {
    plSheetSongId = songId;
    renderPlSheet();
    $("pl-backdrop").hidden = false;
  }
  function renderPlSheet() {
    var wrap = $("pl-sheet-list");
    var title = $("pl-sheet-title");
    if (!wrap) return;
    var s = songById(plSheetSongId);
    if (title) title.textContent = s ? "Add “" + s.title + "” to…" : "Add to playlist";
    wrap.innerHTML = "";
    if (!playlists.length) {
      wrap.innerHTML = '<p class="pl-sheet-none">No playlists yet — create one in the Playlists tab.</p>';
      return;
    }
    playlists.forEach(function (pl) {
      var inList = pl.songIds.indexOf(plSheetSongId) >= 0;
      var row = document.createElement("button");
      row.type = "button";
      row.className = "pl-sheet-row" + (inList ? " in-list" : "");
      row.textContent = (inList ? "✓ " : "○ ") + pl.name + " (" + pl.songIds.length + ")";
      row.addEventListener("click", function () {
        var i = pl.songIds.indexOf(plSheetSongId);
        if (i >= 0) pl.songIds.splice(i, 1);
        else pl.songIds.push(plSheetSongId);
        savePlaylists(); renderPlaylists(); renderPlSheet();
        if (openPlaylistId === pl.id) renderPlaylistSongs();
      });
      wrap.appendChild(row);
    });
  }
  function closePlSheet() {
    $("pl-backdrop").hidden = true;
    plSheetSongId = null;
  }

  /* ============================================================
     WAV export (native bridge in the app, browser download otherwise)
     ============================================================ */
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
        var s2 = Math.max(-1, Math.min(1, chans[c2][i]));
        v.setInt16(o, s2 < 0 ? s2 * 0x8000 : s2 * 0x7FFF, true); o += 2;
      }
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function b64(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    return btoa(s);
  }

  function saveWavFile(blob, filename) {
    var native = window.VocalPureAndroid && window.VocalPureAndroid.writeFile;
    if (native) {
      return blob.arrayBuffer().then(function (ab) {
        var u8 = new Uint8Array(ab);
        var CHUNK = 1.5 * 1024 * 1024;
        var total = Math.ceil(u8.length / CHUNK);
        var doneP = Promise.resolve();
        for (var i = 0; i < total; i++) {
          (function (i) {
            doneP = doneP.then(function () {
              var part = u8.subarray(i * CHUNK, Math.min(u8.length, (i + 1) * CHUNK));
              var r = native(filename, b64(part), i === total - 1);
              if (typeof r === "string" && r.indexOf("error") === 0) {
                throw new Error(r);
              }
            });
          })(i);
        }
        return doneP;
      });
    }
    /* plain browser: normal download */
    return new Promise(function (res, rej) {
      try {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          try { document.body.removeChild(a); } catch (e) { /* ignore */ }
          try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        }, 4000);
        res();
      } catch (e) { rej(e); }
    });
  }

  function setExporting(busy) {
    exporting = busy;
    var dis = busy || !buffer;
    ["exp-vocals", "exp-karaoke", "exp-mix"].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = dis;
    });
  }

  function renderExport(kind) {
    var song = currentSong();
    if (!song || !buffer) { toast("Play a song first, then export your mix."); return; }
    if (exporting) return;
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) { toast("Export is not supported here.", "error"); return; }
    if (!ensureCtx()) return;
    var sr = buffer.sampleRate || 44100;
    if (buffer.duration > 15 * 60) { toast("That song is over 15 minutes — export supports up to 15 min.", "error"); return; }
    var len = Math.max(1, Math.floor(buffer.duration * sr));
    var labels = { vocals: "vocals-only", karaoke: "karaoke", mix: "custom mix" };
    var profile = effectiveProfile(song, buffer);
    var strat = STRATEGY_LABELS[profile.strategy] || "default";
    toast("Rendering " + labels[kind] + " (" + strat + ")…");
    setExporting(true);
    var oc;
    try { oc = new OC(2, len, sr); }
    catch (e) { setExporting(false); toast("Not enough memory for this export.", "error"); return; }
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
      var gv = oc.createGain(), gi = oc.createGain();
      gv.gain.value = v; gi.gain.value = i;
      buildStems(oc, src, profile, gv, gi);
      if (v > 0) gv.connect(out);
      if (i > 0) gi.connect(out);
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
      return saveWavFile(wav, safe + " (" + suffix + ").wav").then(function () {
        if (window.VocalPureAndroid && window.VocalPureAndroid.writeFile) {
          toast("Saved “" + safe + " (" + suffix + ").wav” to Music/VocalPure.", "success");
        } else {
          toast("Export finished — check your downloads.", "success");
        }
      }).catch(function (e) {
        toast("Export failed: " + (e && e.message ? e.message : "unknown"), "error");
      });
    }).catch(function () {
      setExporting(false);
      toast("Export failed — try a shorter song.", "error");
    });
  }

  /**
   * Auto Purify: analyze a batch of songs automatically, right after
   * import (one at a time so the UI stays responsive). The resulting
   * profile is persisted, so every track plays with the correct
   * strategy — and its music already removed — from the very first note.
   */
  var analyzing = false;
  function autoAnalyze(ids) {
    var todo = [];
    for (var i = 0; i < ids.length; i++) {
      var s = songById(ids[i]);
      if (s && !s._profile) todo.push(s);
    }
    if (!todo.length || analyzing) { if (todo.length) queueAnalyze(todo); return; }
    analyzing = true;
    var total = todo.length, k = 0;
    toast("Analyzing " + total + (total === 1 ? " song" : " songs") + " automatically…");
    (function step() {
      var s = todo[k++];
      if (!s) {
        analyzing = false;
        toast("Analysis complete — music will be removed automatically.", "success");
        renderHome(); renderSearch();
        if (openPlaylistId) renderPlaylistSongs();
        updateEngineLine();
        var pending = analyzeQueue.slice(); analyzeQueue = [];
        if (pending.length) autoAnalyze(pending);
        return;
      }
      getBuffer(s).then(function (buf) {
        try { s._profile = analyzeBuffer(buf); idbPut(cleanRec(s)); }
        catch (e) { /* falls back to first-play analysis */ }
      }).catch(function () { /* retried on first play */ }).then(function () {
        setTimeout(step, 40);
      });
    })();
  }
  var analyzeQueue = [];
  function queueAnalyze(songs) {
    for (var i = 0; i < songs.length; i++) analyzeQueue.push(songs[i].id);
  }

  /* ============================================================
     Import
     ============================================================ */
  var MAX_FILE = 80 * 1024 * 1024;
  function looksAudio(f) {
    if (!f) return false;
    if (f.type && f.type.indexOf("audio") === 0) return true;
    if (/\.(mp3|wav|m4a|aac|ogg|opus|flac|wma|oga|weba|webm)$/i.test(f.name || "")) return true;
    if (!f.type || f.type === "application/octet-stream" || f.type === "application/x-zip-compressed") return true;
    return false;
  }
  function readAndDecode(f) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () {
        var ab = r.result;
        var realBlob = new Blob([ab], { type: f.type || "audio/mpeg" });
        var abCopy = ab.slice(0);
        decodeArrayBuffer(abCopy).then(function (buf) {
          res({ buffer: buf, blob: realBlob });
        }).catch(rej);
      };
      r.onerror = function () { rej(new Error("read")); };
      try { r.readAsArrayBuffer(f); } catch (e) { rej(e); }
    });
  }
  function loadFiles(files) {
    if (!files || !files.length) return;
    if (!ensureCtx()) { toast("Audio is not supported on this device.", "error"); return; }
    var list = [];
    for (var i = 0; i < files.length; i++) list.push(files[i]);
    var ok = 0, bad = 0, big = 0, idx = 0;
    var newIds = [];
    function next() {
      if (idx >= list.length) {
        renderHome(); renderSearch(); renderPlaylists(); updateCounts();
        if (ok) toast("Added " + ok + " song" + (ok === 1 ? "" : "s") + " to your library.", "success");
        if (bad) toast(bad + " file(s) skipped (not audio or unreadable).", "error");
        if (big) toast(big + " file(s) exceeded 80 MB and were skipped.", "error");
        if (newIds.length) autoAnalyze(newIds);
        if (newIds.length && !currentId) playFromList(newIds, 0);
        return;
      }
      var f = list[idx++];
      if (!looksAudio(f)) { bad++; next(); return; }
      if (f.size > MAX_FILE) { big++; next(); return; }
      readAndDecode(f).then(function (res) {
        var buf = res.buffer;
        var realBlob = res.blob;
        var meta = parseName(f.name);
        var rec = {
          id: uid(), title: meta.title, artist: meta.artist, name: f.name,
          duration: buf ? buf.duration : 0, blob: realBlob, favorite: false, dateAdded: Date.now(),
          _buffer: buf || null, _profile: null, path: null, size: f.size || (realBlob ? realBlob.size : 0)
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

  /* ============================================================
     Screens / navigation
     ============================================================ */
  var SCREENS = ["home", "search", "playlists", "playlist", "settings"];
  var TITLES = { home: "Home", search: "Search", playlists: "Playlists", playlist: "Playlist", settings: "Settings" };

  function showScreen(name) {
    if (SCREENS.indexOf(name) < 0) name = "home";
    for (var i = 0; i < SCREENS.length; i++) {
      var el = $("screen-" + SCREENS[i]);
      if (el) el.hidden = (SCREENS[i] !== name);
    }
    var tabs = document.querySelectorAll("#tabbar .tab");
    for (var t = 0; t < tabs.length; t++) {
      var active = (name === tabs[t].getAttribute("data-screen")) ||
        (name === "playlist" && tabs[t].getAttribute("data-screen") === "playlists");
      tabs[t].classList.toggle("is-active", active);
    }
    var title = $("topbar-title");
    if (title) title.textContent = TITLES[name] || "Home";
  }

  /* ============================================================
     Device Music & Permissions
     ============================================================ */
  function updatePermissionUI() {
    var badge = $("perm-status-badge");
    var btnGrant = $("btn-grant-permission");
    var banner = $("perm-banner");
    var hasNative = !!(window.VocalPureAndroid && window.VocalPureAndroid.hasStoragePermission);
    if (!hasNative) {
      if (badge) { badge.textContent = "Web Browser"; badge.style.color = "var(--text-sub)"; }
      if (btnGrant) btnGrant.hidden = true;
      if (banner) banner.hidden = true;
      return;
    }
    var granted = false;
    try { granted = window.VocalPureAndroid.hasStoragePermission(); } catch (e) { granted = false; }
    if (badge) {
      badge.textContent = granted ? "Granted ✓" : "Permission Needed";
      badge.style.color = granted ? "var(--teal)" : "#f87171";
    }
    if (btnGrant) {
      btnGrant.textContent = granted ? "Permissions OK ✓" : "Grant Permissions";
      btnGrant.disabled = granted;
    }
    if (banner) {
      banner.hidden = granted;
    }
  }

  function requestDevicePermissions() {
    if (window.VocalPureAndroid && window.VocalPureAndroid.requestStoragePermission) {
      window.VocalPureAndroid.requestStoragePermission();
    } else {
      toast("Select audio files using the file picker.", "info");
      $("file-input").click();
    }
  }

  function scanDeviceMusic() {
    if (!window.VocalPureAndroid || !window.VocalPureAndroid.scanDeviceAudio) {
      toast("Device scanning is available in the Android app.", "info");
      $("file-input").click();
      return;
    }

    var granted = false;
    try { granted = window.VocalPureAndroid.hasStoragePermission(); } catch (e) { granted = false; }
    if (!granted) {
      toast("Requesting music permissions…");
      window.VocalPureAndroid.requestStoragePermission();
      return;
    }

    toast("Scanning phone for music files…");
    setTimeout(function () {
      try {
        var jsonStr = window.VocalPureAndroid.scanDeviceAudio();
        var files = JSON.parse(jsonStr || "[]");
        if (!files || !files.length) {
          toast("No music files found in phone storage.", "info");
          return;
        }

        var existingPaths = {}, existingNames = {};
        for (var i = 0; i < library.length; i++) {
          if (library[i].path) existingPaths[library[i].path] = true;
          existingNames[(library[i].artist + " - " + library[i].title).toLowerCase()] = true;
        }

        var addedCount = 0;
        var newIds = [];
        for (var j = 0; j < files.length; j++) {
          var item = files[j];
          if (item.path && existingPaths[item.path]) continue;
          var key = ((item.artist || "") + " - " + (item.title || "")).toLowerCase();
          if (existingNames[key]) continue;

          var rec = {
            id: uid(),
            title: item.title || item.name || "Unknown Track",
            artist: item.artist || "Device audio",
            name: item.name || item.title || "audio",
            duration: item.duration || 0,
            blob: null,
            path: item.path,
            size: item.size || 0,
            favorite: false,
            dateAdded: Date.now(),
            _buffer: null,
            _profile: null
          };
          library.push(rec);
          idbPut(cleanRec(rec));
          newIds.push(rec.id);
          existingPaths[item.path] = true;
          existingNames[key] = true;
          addedCount++;
        }

        renderHome();
        renderSearch();
        renderPlaylists();
        updateCounts();

        if (addedCount > 0) {
          toast("Found & added " + addedCount + " music track" + (addedCount === 1 ? "" : "s") + " from your phone!", "success");
          if (newIds.length) autoAnalyze(newIds);
          if (!currentId && newIds.length > 0) {
            playFromList(newIds, 0);
          }
        } else {
          toast("All " + files.length + " phone music tracks are already in your library.", "info");
        }
      } catch (err) {
        toast("Scan error: " + (err && err.message ? err.message : "could not read files"), "error");
      }
    }, 50);
  }

  window.onDevicePermissionResult = function (granted) {
    updatePermissionUI();
    if (granted) {
      toast("Permission granted! Scanning phone for music…", "success");
      scanDeviceMusic();
    } else {
      toast("Storage permission is required to access your music.", "error");
    }
  };

  /* ============================================================
     Events
     ============================================================ */
  on($("btn-import"), "click", function () { $("file-input").click(); });
  on($("btn-hero-import"), "click", function () { $("file-input").click(); });
  on($("btn-hero-scan"), "click", scanDeviceMusic);
  on($("btn-top-scan"), "click", scanDeviceMusic);
  on($("btn-empty-import"), "click", function () { $("file-input").click(); });
  on($("btn-empty-scan"), "click", scanDeviceMusic);
  on($("btn-banner-grant"), "click", requestDevicePermissions);
  on($("btn-grant-permission"), "click", requestDevicePermissions);
  on($("btn-settings-scan"), "click", scanDeviceMusic);
  on($("file-input"), "change", function () {
    var fi = $("file-input");
    if (fi.files && fi.files.length) loadFiles(fi.files);
    fi.value = "";
  });
  on($("btn-play-all"), "click", function () {
    var songs = viewHome();
    if (songs.length) playFromList(songs.map(function (s) { return s.id; }), 0);
  });

  document.querySelectorAll("#tabbar .tab").forEach(function (btn) {
    btn.addEventListener("click", function () { showScreen(btn.getAttribute("data-screen")); });
  });

  /* search */
  var searchInput = $("search-input");
  on(searchInput, "input", function () {
    searchQuery = (searchInput.value || "").trim();
    $("search-clear").hidden = !searchQuery;
    renderSearch();
  });
  on($("search-clear"), "click", function () {
    searchInput.value = "";
    searchQuery = "";
    $("search-clear").hidden = true;
    renderSearch();
    searchInput.focus();
  });

  /* playlists */
  on($("btn-new-playlist"), "click", function () {
    var name = "";
    try { name = prompt("Playlist name", "Playlist " + (playlists.length + 1)) || ""; } catch (e) { name = "Playlist " + (playlists.length + 1); }
    name = String(name || "").trim().slice(0, 40) || ("Playlist " + (playlists.length + 1));
    playlists.push({ id: uid(), name: name, songIds: [] });
    savePlaylists(); renderPlaylists();
    toast("Playlist “" + name + "” created.", "success");
  });
  on($("pl-back"), "click", function () {
    openPlaylistId = null;
    showScreen("playlists");
  });
  on($("pl-play-all"), "click", function () {
    var p = playlists.filter(function (x) { return x.id === openPlaylistId; })[0];
    if (p && p.songIds.length) playFromList(p.songIds.slice(), 0);
    else toast("This playlist is empty — add songs first.");
  });
  on($("pl-delete"), "click", function () {
    var p = playlists.filter(function (x) { return x.id === openPlaylistId; })[0];
    if (!p) return;
    var okc = true;
    try { okc = confirm('Delete playlist "' + p.name + '"?'); } catch (e) { okc = true; }
    if (!okc) return;
    playlists = playlists.filter(function (x) { return x.id !== openPlaylistId; });
    savePlaylists(); renderPlaylists();
    openPlaylistId = null;
    showScreen("playlists");
    toast("Playlist deleted.");
  });

  /* settings */
  on($("set-autopurify"), "click", function () {
    autoPurify = !autoPurify;
    updateAutoUI();
    saveSettings();
    if (autoPurify) {
      if (buffer && mode !== "vocals") {
        if (mode === "custom") { customMem.v = stemV; customMem.i = stemI; }
        mode = "vocals"; stemV = 100; stemI = 0;
        for (var k = 0; k < modeBtns.length; k++) {
          modeBtns[k].classList.toggle("is-active", modeBtns[k].getAttribute("data-mode") === "vocals");
        }
        updateStemUI(); updateNp();
        if (playing) startAt(currentPos()); else applyStemGains();
        updateEngineLine();
      }
      toast("Auto purify on — music is removed automatically.", "success");
    } else {
      toast("Auto purify off — songs play untouched until you pick a mode.");
    }
  });
  on($("set-volume"), "input", function () {
    volume = Number($("set-volume").value) || 0;
    if (volume > 0 && muted) muted = false;
    applyVolume();
    saveSettings();
  });
  on($("set-rate"), "change", function () {
    var r = Number($("set-rate").value) || 1;
    if (playing && buffer) { offsetBase = currentPos(); startCtxTime = actx.currentTime; }
    playbackRate = r;
    if (source) {
      try { source.playbackRate.setTargetAtTime(r, actx.currentTime, 0.02); }
      catch (e) { try { source.playbackRate.value = r; } catch (e2) { /* ignore */ } }
    }
    saveSettings();
  });
  on($("set-sleep"), "change", function () {
    var mins = Number($("set-sleep").value) || 0;
    if (mins > 0) {
      sleepAt = Date.now() + mins * 60000;
      toast("Sleep timer: playback stops in " + mins + " min.", "success");
    } else {
      sleepAt = 0;
      toast("Sleep timer off.");
    }
  });
  on($("btn-clear-library"), "click", function () {
    if (!library.length) { toast("Library is already empty."); return; }
    var okc = false;
    try { okc = confirm("Remove ALL " + library.length + " songs from this device?"); } catch (e) { okc = false; }
    if (!okc) return;
    stopPlayback();
    buffer = null; currentId = null; duration = 0; offsetBase = 0;
    queue = []; qi = -1;
    library.forEach(function (s) { idbDel(s.id); });
    library = [];
    playlists = [];
    savePlaylists();
    $("np-title").textContent = "Nothing playing";
    $("np-artist").textContent = "Add songs to get started";
    renderHome(); renderSearch(); renderPlaylists(); renderQueue(); updateCounts(); updateNp();
    updateProgressUI(); drawViz();
    toast("Library cleared.");
  });

  /* now playing */
  on($("btn-play"), "click", togglePlay);
  on($("btn-next"), "click", stepNext);
  on($("btn-prev"), "click", stepPrev);
  on($("np-back"), "click", closeNp);
  on($("np-fav"), "click", function () { if (currentId) toggleFav(currentId); });

  on($("btn-shuffle"), "click", function () {
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
    $("btn-shuffle").classList.toggle("is-active", shuffle);
    $("btn-shuffle").setAttribute("aria-pressed", shuffle ? "true" : "false");
    saveSettings();
    toast("Shuffle " + (shuffle ? "on." : "off."));
  });
  on($("btn-repeat"), "click", function () {
    repeatMode = repeatMode === "off" ? "all" : (repeatMode === "all" ? "one" : "off");
    $("btn-repeat").classList.toggle("is-active", repeatMode !== "off");
    $("btn-repeat").setAttribute("aria-pressed", repeatMode !== "off" ? "true" : "false");
    saveSettings();
    toast("Repeat: " + repeatMode + ".");
  });

  /* seek */
  var prog = $("np-progress");
  if (prog) {
    prog.addEventListener("click", function (e) {
      var rect = prog.getBoundingClientRect();
      if (rect.width <= 0) return;
      seekTo((e.clientX - rect.left) / rect.width);
    });
    prog.addEventListener("keydown", function (e) {
      if (!buffer || duration <= 0) return;
      if (e.key === "ArrowRight") { e.preventDefault(); seekTo((currentPos() + 5) / duration); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seekTo((currentPos() - 5) / duration); }
      else if (e.key === "Home") { e.preventDefault(); seekTo(0); }
      else if (e.key === "End") { e.preventDefault(); seekTo(1); }
    });
  }

  /* np panels */
  document.querySelectorAll(".np-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var panel = btn.getAttribute("data-panel");
      document.querySelectorAll(".np-tab").forEach(function (b) {
        var active = b === btn;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      ["sound", "eq", "queue"].forEach(function (p) {
        var el = $("panel-" + p);
        if (el) el.hidden = (p !== panel);
      });
    });
  });

  /* modes */
  modeBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var m = btn.getAttribute("data-mode");
      if (m === mode) return;
      if (!buffer) { toast("Play a song first."); return; }
      setMode(m, { fromButton: true });
    });
  });

  /* stems */
  on($("stem-vocal"), "input", function () {
    stemV = Number($("stem-vocal").value) || 0;
    ensureCustomMix();
    updateStemUI(); applyStemGains(); saveSettings();
  });
  on($("stem-music"), "input", function () {
    stemI = Number($("stem-music").value) || 0;
    ensureCustomMix();
    updateStemUI(); applyStemGains(); saveSettings();
  });
  on($("mute-vocal"), "click", function () { muteV = !muteV; ensureCustomMix(); updateStemUI(); applyStemGains(); });
  on($("mute-music"), "click", function () { muteI = !muteI; ensureCustomMix(); updateStemUI(); applyStemGains(); });
  on($("solo-vocal"), "click", function () { soloV = !soloV; ensureCustomMix(); updateStemUI(); applyStemGains(); });
  on($("solo-music"), "click", function () { soloI = !soloI; ensureCustomMix(); updateStemUI(); applyStemGains(); });

  /* export */
  on($("exp-vocals"), "click", function () { renderExport("vocals"); });
  on($("exp-karaoke"), "click", function () { renderExport("karaoke"); });
  on($("exp-mix"), "click", function () { renderExport("mix"); });

  /* eq */
  for (var eb = 0; eb < 5; eb++) {
    (function (idx) {
      on($("eq-" + idx), "input", function () {
        eqGains[idx] = Number($("eq-" + idx).value) || 0;
        eqPresetName = "custom";
        updateEqUI(); applyEQ(); saveSettings();
      });
    })(eb);
  }
  on($("eq-preset"), "change", function () {
    var name = $("eq-preset").value;
    if (EQ_PRESETS[name]) {
      eqPresetName = name;
      eqGains = EQ_PRESETS[name].slice();
      updateEqUI(); applyEQ(); saveSettings();
    }
  });
  on($("eq-reset"), "click", function () {
    eqPresetName = "normal";
    eqGains = [0, 0, 0, 0, 0];
    eqOn = true;
    updateEqUI(); applyEQ(); saveSettings();
    toast("Equalizer reset.");
  });
  on($("eq-on"), "click", function () {
    eqOn = !eqOn;
    updateEqUI(); applyEQ(); saveSettings();
  });

  /* queue */
  on($("queue-clear"), "click", function () {
    queue = []; qi = -1;
    renderQueue();
    toast("Queue cleared.");
  });
  var ql = $("queue-list");
  if (ql) {
    ql.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-q]") : null;
      if (!b) return;
      qi = Number(b.getAttribute("data-q")) || 0;
      loadSongById(queue[qi], true);
    });
  }

  /* playlist sheet */
  on($("pl-sheet-close"), "click", closePlSheet);
  on($("pl-backdrop"), "click", function (e) {
    if (e.target === $("pl-backdrop")) closePlSheet();
  });

  /* row actions (home + search lists) */
  attachRowActions($("home-list"));
  attachRowActions($("search-list"));

  /* keyboard: escape closes sheets / np */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!$("pl-backdrop").hidden) closePlSheet();
    else if (!npScreen.hidden) closeNp();
  });

  window.addEventListener("resize", function () { sizeViz(); });

  /* audio context unlock on first touch/click */
  function unlockAudio() {
    if (actx && actx.state === "suspended") {
      actx.resume().catch(function () {});
    }
  }
  document.addEventListener("click", unlockAudio, true);
  document.addEventListener("touchstart", unlockAudio, true);

  /* ============================================================
     Init
     ============================================================ */
  function init() {
    loadSettings();
    volume = settings.volume;
    playbackRate = settings.rate || 1;
    stemV = settings.stemV; stemI = settings.stemI;
    customMem.v = settings.customV; customMem.i = settings.customI;
    eqGains = settings.eq.slice(); eqOn = !!settings.eqOn;
    eqPresetName = settings.eqPreset || "normal";
    shuffle = !!settings.shuffle; repeatMode = settings.repeat || "off";
    autoPurify = settings.autoPurify !== false;
    /* Auto Purify: the app launches straight into vocals-only (music removed) */
    if (autoPurify) { mode = "vocals"; stemV = 100; stemI = 0; }
    syncModeButtons();

    $("set-volume").value = String(volume);
    syncVolumeUI();
    $("set-rate").value = String(playbackRate);
    $("btn-shuffle").classList.toggle("is-active", shuffle);
    $("btn-shuffle").setAttribute("aria-pressed", shuffle ? "true" : "false");
    $("btn-repeat").classList.toggle("is-active", repeatMode !== "off");
    $("btn-repeat").setAttribute("aria-pressed", repeatMode !== "off" ? "true" : "false");
    updateEqUI();
    updateStemUI();
    updateAutoUI();

    /* version + changelog: native bridge first, bundled app-info.json as
       fallback (fetch, then XHR for older WebViews) */
    var versionSet = false;
    function applyVersion(txt) {
      if (versionSet) return;
      versionSet = true;
      $("set-version").textContent = txt;
    }
    if (window.VocalPureAndroid && window.VocalPureAndroid.appInfo) {
      try {
        var bridgeInfo = JSON.parse(window.VocalPureAndroid.appInfo());
        if (bridgeInfo.versionName) applyVersion("v" + bridgeInfo.versionName);
      } catch (e) { /* fall through */ }
    }
    function loadAppInfo() {
      function onInfo(info) {
        if (!versionSet && info && info.version) applyVersion("v" + info.version);
        var cl = $("set-changelog");
        if (cl && info && info.changelog && info.changelog.length) {
          cl.innerHTML = "";
          info.changelog.forEach(function (item) {
            var li = document.createElement("li");
            li.textContent = item;
            cl.appendChild(li);
          });
        }
      }
      if (window.fetch) {
        fetch("app-info.json", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(onInfo)
          .catch(function () { /* stay at defaults */ });
      } else if (window.XMLHttpRequest) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "app-info.json", true);
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { onInfo(JSON.parse(xhr.responseText)); } catch (e) { /* ignore */ }
          }
        };
        try { xhr.send(); } catch (e) { /* ignore */ }
      }
    }
    loadAppInfo();

    loadPlaylists();
    renderHome();
    renderSearch();
    renderPlaylists();
    renderQueue();
    updateNp();
    updateCounts();
    updateEngineLine();
    showScreen("home");
    sizeViz();
    drawIdleViz(0);

    idbAll().then(function (recs) {
      library = (recs || []).map(function (r) {
        return {
          id: r.id, title: r.title || "Unknown", artist: r.artist || "Unknown artist",
          name: r.name || r.title || "Unknown", duration: r.duration || 0,
          blob: r.blob || null, favorite: !!r.favorite, dateAdded: r.dateAdded || 0,
          _buffer: null, _profile: r.profile || null,
          path: r.path || null, size: r.size || 0
        };
      }).filter(function (r) { return r.id; });
      renderHome(); renderSearch(); renderPlaylists(); updateCounts();
      updatePermissionUI();
      if (library.length) {
        toast("Restored " + library.length + " song" + (library.length === 1 ? "" : "s") + " from your library.", "success");
      }
    }).catch(function () { idbFailed = true; });

    updatePermissionUI();
    if (window.VocalPureAndroid && window.VocalPureAndroid.hasStoragePermission) {
      var granted = false;
      try { granted = window.VocalPureAndroid.hasStoragePermission(); } catch (e) {}
      if (granted) {
        setTimeout(function () {
          if (!library.length) scanDeviceMusic();
        }, 350);
      } else {
        setTimeout(function () {
          if (window.VocalPureAndroid.requestStoragePermission) {
            window.VocalPureAndroid.requestStoragePermission();
          }
        }, 800);
      }
    }

    (function idle() {
      if (!playing) drawIdleViz(performance.now());
      requestAnimationFrame(idle);
    })();

    setInterval(function () {
      var line = $("sleep-line");
      if (sleepAt && Date.now() >= sleepAt) {
        sleepAt = 0;
        $("set-sleep").value = "0";
        fadeAndPause();
        toast("Sleep timer — playback stopped.");
        if (line) line.hidden = true;
      } else if (sleepAt) {
        if (line) { line.hidden = false; line.textContent = "⏾ " + sleepLabel(); }
      } else if (line) {
        line.hidden = true;
      }
    }, 1000);
  }

  init();
})();
