/* ============================================================
   VocalPure app — standalone music player engine  (engine v6)

   The app has exactly one way to play a song: the AI voice engine
   isolates the voice and the music is removed. There is no mode
   selector, no stem mixer and no "music" level anywhere — the
   listener always hears the voice, never the music.

   Engine v6 changes (vs the v5 four-mode engine):
     · real-time AI separation in an AudioWorklet — streaming STFT
       soft-masking driven by an online-learned voice/music profile,
       centre-channel coherence, pitch/harmonic tracking and a
       syllabic-modulation cue (see app/vp-ai-engine.js)
     · playback is STREAMED through a media element: songs are never
       decoded into an AudioBuffer any more, so large files no longer
       exhaust memory (this was the crash the old engine hit)
     · audio bytes live in their own IndexedDB store and are read one
       song at a time; only metadata is loaded on launch
     · the WAV export records the purified voice as it plays instead of
       rendering a two-hour AudioBuffer in memory
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

/* ============================================================
   Persistent settings
   NOTE: there is no mode / stem / "music level" setting any more.
   The app always plays the isolated voice; the only knobs are how
   hard the AI engine pushes the music down and how loud the voice
   comes out.
   ============================================================ */
  var SETTINGS_KEY = "vp-app-settings-v5";
  var LEGACY_SETTINGS_KEYS = ["vp-app-settings-v4", "vp-app-settings-v3"];
  var settings = {
    volume: 80, rate: 1,
    /* Max / "100% Isolation" is the default: the pure (hard) mask path
       removes the music completely, leaving only the voice. */
    aiStrength: "max", aiBoost: 6, aiDenoise: true,
    audioOutput: "auto",
    eqOn: true, eq: [0, 0, 0, 0, 0], eqPreset: "normal",
    shuffle: false, repeat: "off"
  };
  var AI_STRENGTHS = ["soft", "balanced", "strong", "max"];
  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        /* Carry over harmless transport preferences, but deliberately do not
           carry an old weak separator preset. v2/v3 users were often left on
           Soft/Balanced, which is exactly why music was audible after this
           release promised voice-only playback. A migration starts at Max;
           the user can still choose another preset afterwards. */
        for (var li = 0; li < LEGACY_SETTINGS_KEYS.length && !raw; li++) {
          raw = localStorage.getItem(LEGACY_SETTINGS_KEYS[li]);
        }
        if (raw) {
          var old = JSON.parse(raw) || {};
          ["volume", "rate", "aiBoost", "aiDenoise", "audioOutput",
           "eqOn", "eq", "eqPreset", "shuffle", "repeat"].forEach(function (k) {
            if (old[k] !== undefined && old[k] !== null) settings[k] = old[k];
          });
        }
      } else {
        var s = JSON.parse(raw) || {};
        for (var k2 in settings) {
          if (s[k2] === undefined || s[k2] === null) continue;
          if (k2 === "eq" && Array.isArray(s[k2]) && s[k2].length === 5) {
            settings.eq = s[k2].map(function (v) { return Math.max(-12, Math.min(12, Number(v) || 0)); });
          } else settings[k2] = s[k2];
        }
      }
    } catch (e) { /* defaults */ }
    if (AI_STRENGTHS.indexOf(settings.aiStrength) < 0) settings.aiStrength = "max";
    settings.aiBoost = Math.max(0, Math.min(18, Number(settings.aiBoost) || 0));
    settings.aiDenoise = settings.aiDenoise !== false;
    if (AUDIO_OUTPUTS.indexOf(settings.audioOutput) < 0) settings.audioOutput = "auto";
    if (["off", "all", "one"].indexOf(settings.repeat) < 0) settings.repeat = "off";
  }
  var AUDIO_OUTPUTS = ["auto", "speaker", "earpiece", "bluetooth", "wired"];
  var OUTPUT_LABELS = {
    auto: "Auto (system)", speaker: "Loudspeaker", earpiece: "Phone earpiece",
    bluetooth: "Bluetooth", wired: "Wired headset"
  };

  function saveSettings() {
    try {
      settings.volume = volume; settings.rate = playbackRate;
      settings.aiStrength = aiStrength;
      settings.aiBoost = aiBoostDb;
      settings.aiDenoise = aiDenoise;
      settings.audioOutput = audioOutput;
      settings.eqOn = eqOn; settings.eq = eqGains.slice(); settings.eqPreset = eqPresetName;
      settings.shuffle = shuffle; settings.repeat = repeatMode;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { /* ignore */ }
  }

/* ============================================================
   Local storage — metadata and audio bytes live in TWO stores:
     songs  : light metadata only (title, artist, duration, path…)
     files  : id → Blob, read on demand, one song at a time
   Splitting them is what keeps a library of large files from
   blowing up memory on launch: the app never reads all audio
   into memory, and never decodes a whole song to play it.
   ============================================================ */
  var IDB_NAME = "vp-app-db", IDB_STORE = "songs", IDB_FILES = "files";
  var idbDb = null, idbFailed = false;
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (idbDb) { res(idbDb); return; }
      if (!window.indexedDB) { rej(new Error("no indexedDB")); return; }
      var req = window.indexedDB.open(IDB_NAME, 2);
      req.onupgradeneeded = function () {
        var db = req.result, tx = req.transaction;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(IDB_FILES)) db.createObjectStore(IDB_FILES);
        /* v1 kept the audio blob inside the metadata record — move it out */
        if (tx && db.objectStoreNames.contains(IDB_STORE)) {
          var meta = tx.objectStore(IDB_STORE), files = tx.objectStore(IDB_FILES);
          var cur = meta.openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c) return;
            var v = c.value;
            if (v && v.blob) {
              files.put(v.blob, v.id);
              var slim = {};
              for (var k in v) slim[k] = v[k];
              delete slim.blob;
              slim.streamed = true;
              c.update(slim);
            }
            c.continue();
          };
        }
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
  function idbPutFile(id, blob) {
    if (idbFailed || !window.indexedDB || !blob) return Promise.resolve(false);
    return idbOpen().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(IDB_FILES, "readwrite");
        tx.objectStore(IDB_FILES).put(blob, id);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
      });
    }).catch(function () { return false; });
  }
  function idbGetFile(id) {
    if (idbFailed || !window.indexedDB) return Promise.resolve(null);
    return idbOpen().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(IDB_FILES, "readonly");
        var rq = tx.objectStore(IDB_FILES).get(id);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }
  function idbDel(id) {
    if (idbFailed || !window.indexedDB) return;
    idbOpen().then(function (db) {
      var tx = db.transaction([IDB_STORE, IDB_FILES], "readwrite");
      tx.objectStore(IDB_STORE).delete(id);
      tx.objectStore(IDB_FILES).delete(id);
    }).catch(function () { /* ignore */ });
  }
  function cleanRec(s) {
    return {
      id: s.id, title: s.title, artist: s.artist, name: s.name,
      duration: s.duration || 0, favorite: !!s.favorite,
      dateAdded: s.dateAdded || Date.now(), profile: s._profile || null,
      size: s.size || 0, path: s.path || null,
      cover: (s.cover && s.cover.length <= COVER_STORE_MAX) ? s.cover : null,
      streamed: !!s.streamed
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
     On-device AI analysis (bounded, streaming-safe)

     The app never decodes a whole song: playback is streamed
     through the AI engine (app/vp-ai-engine.js), and the "is this
     voice or music?" decision is learned continuously while the
     song plays — nothing about it depends on file size.

     On top of that, a *bounded* probe gives an instant estimate
     when a song is imported: only the first ~420 KB of the file
     are fetched (a byte range for device files, a blob slice for
     imported files) and decoded, which is a few seconds of audio
     at most. Everything is discarded right after measuring.
     ============================================================ */
  var PROBE_BYTES = 420 * 1024;        /* max bytes read for the instant probe */
  var PROBE_MAX_PCM = 44100 * 2 * 40;  /* ≤ ~40 s of decoded audio (≈14 MB)    */

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
   * Measures a *short* decoded buffer (a probe slice, never a whole song):
   * how much of the voice band sits in the centre channel, how much of the
   * total energy is voice-band energy, and how much low / high content the
   * track has. Returns null when there is not enough audio to judge.
   */
  function analyzeSlice(buf) {
    if (!buf || !buf.length || buf.duration < 0.4) return null;
    var sr = buf.sampleRate, nch = buf.numberOfChannels;
    var L = buf.getChannelData(0);
    var R = nch >= 2 ? buf.getChannelData(1) : null;
    var stereo = nch >= 2;
    var N = 1024, hop = 512;
    var maxFrames = Math.max(8, Math.min(600, Math.floor(L.length / hop) - 2));
    var reL = new Float64Array(N), imL = new Float64Array(N);
    var reR = new Float64Array(N), imR = new Float64Array(N);
    var vocalMid = 0, vocalSide = 0, lowMid = 0, highMid = 0, bandPow = 0, totalPow = 0;
    var frames = 0, peak = 0, sumSq = 0, samples = 0;

    for (var off = 0; off + N < L.length && frames < maxFrames; off += hop) {
      for (var i = 0; i < N; i++) {
        reL[i] = L[off + i] || 0; imL[i] = 0;
        reR[i] = (stereo ? R[off + i] : reL[i]) || 0; imR[i] = 0;
      }
      fft(reL, imL);
      if (stereo) fft(reR, imR);
      for (var b = 1; b <= N / 2; b++) {
        var f = b * sr / N;
        var midR = (reL[b] + reR[b]) * 0.5, midI = (imL[b] + imR[b]) * 0.5;
        var mp = midR * midR + midI * midI;
        var sp = 0;
        if (stereo) {
          var sR = (reL[b] - reR[b]) * 0.5, sI = (imL[b] - imR[b]) * 0.5;
          sp = sR * sR + sI * sI;
        }
        if (f >= 30 && f < 150) lowMid += mp;
        else if (f >= 150 && f < 4300) { vocalMid += mp; vocalSide += sp; bandPow += mp + sp; }
        else if (f >= 4300 && f < 12000) highMid += mp;
        totalPow += mp + sp;
      }
      for (i = off; i < off + N; i += 8) {
        var s = L[i] || 0;
        sumSq += s * s; samples++;
        var av = s < 0 ? -s : s;
        if (av > peak) peak = av;
      }
      frames++;
    }
    if (!frames) return null;
    var centerRatio = (vocalMid + vocalSide) > 0 ? vocalMid / (vocalMid + vocalSide) : 0;
    var bandFocus = totalPow > 0 ? bandPow / totalPow : 0;
    var lowRatio = totalPow > 0 ? lowMid / totalPow : 0;
    var highRatio = totalPow > 0 ? highMid / totalPow : 0;
    var rms = samples ? Math.sqrt(sumSq / samples) : 0;
    var clarity = 30 + centerRatio * 42 + Math.min(22, bandFocus * 55);
    if (!stereo) clarity = 26 + Math.min(30, bandFocus * 60);
    clarity = Math.max(15, Math.min(98, Math.round(clarity)));
    return {
      ai: true, probe: true, engine: "vp-ai-v6",
      stereo: stereo, frames: frames,
      centerRatio: Math.round(centerRatio * 1000) / 1000,
      bandFocus: Math.round(bandFocus * 1000) / 1000,
      lowRatio: Math.round(lowRatio * 1000) / 1000,
      highRatio: Math.round(highRatio * 1000) / 1000,
      rms: Math.round(rms * 1000) / 1000,
      peak: Math.round(peak * 1000) / 1000,
      clarity: clarity,
      at: Date.now()
    };
  }

  /* An almost-empty take (silence / intros) must not overwrite good data. */
  function usableProfile(p) {
    return !!p && (p.live ? true : (p.rms > 0.004 && p.frames >= 8));
  }

  function decodeSliceBytes(ab) {
    return new Promise(function (resolve) {
      if (!ensureCtx()) { resolve(null); return; }
      var done = false;
      function ok(b) { if (!done) { done = true; resolve(b && b.length <= PROBE_MAX_PCM ? b : (b || null)); } }
      function fail() { if (!done) { done = true; resolve(null); } }
      try {
        var pr = actx.decodeAudioData(ab, ok, fail);
        if (pr && typeof pr.then === "function") pr.then(ok, fail);
      } catch (e) { fail(); }
    });
  }

  /**
   * Bounded probe for one song. Reads at most PROBE_BYTES from the start of
   * the audio (Range request for device files, blob slice for imported ones),
   * decodes it and measures it. Never throws, never keeps the bytes.
   */
  function probeSong(song) {
    if (!song) return Promise.resolve(null);
    var bytes = null;
    if (song.blob) {
      bytes = song.blob.slice(0, Math.min(song.blob.size || PROBE_BYTES, PROBE_BYTES)).arrayBuffer();
    } else if (song.path) {
      var url = deviceAudioUrl(song.path);
      if (window.fetch) {
        bytes = fetch(url, { headers: { Range: "bytes=0-" + (PROBE_BYTES - 1) }, cache: "no-store" })
          .then(function (res) { return res.ok || res.status === 206 ? res.arrayBuffer() : null; })
          .catch(function () { return null; });
      }
    }
    if (!bytes) return Promise.resolve(null);
    var promise = (bytes && typeof bytes.then === "function") ? bytes : Promise.resolve(bytes);
    return promise.then(function (ab) {
      if (!ab) return null;
      return decodeSliceBytes(ab).then(function (buf) {
        var p = analyzeSlice(buf);
        return usableProfile(p) ? p : null;
      });
    }).catch(function () { return null; });
  }

  /* Songs waiting for their instant probe (one at a time, background) */
  var probeQueue = [], probing = false;
  function queueAnalysis(ids) {
    if (!ids || !ids.length) return;
    for (var i = 0; i < ids.length; i++) {
      var s = songById(ids[i]);
      if (s && !s._profile && probeQueue.indexOf(s.id) < 0) probeQueue.push(s.id);
    }
    if (probing) return;
    probing = true;
    var total = probeQueue.length;
    if (total > 1) toast("AI is analyzing " + total + " songs…");
    (function step() {
      var id = probeQueue.shift();
      if (!id) {
        probing = false;
        renderHome(); renderSearch();
        if (openPlaylistId) renderPlaylistSongs();
        updateEngineLine();
        if (total > 1) toast("AI analysis finished — every song is ready.", "success");
        return;
      }
      var s = songById(id);
      if (!s) { setTimeout(step, 20); return; }
      probeSong(s).then(function (p) {
        if (p) {
          s._profile = p;
          idbPut(cleanRec(s));
          renderHome(); renderSearch();
          if (openPlaylistId) renderPlaylistSongs();
          updateEngineLine();
        }
        setTimeout(step, 30);
      }).catch(function () { setTimeout(step, 30); });
    })();
  }
/* ============================================================
     Embedded cover art — extracted from the file itself

     The artwork travels INSIDE the audio file (ID3v2 APIC for MP3,
     PICTURE block for FLAC, covr atom for M4A, METADATA_BLOCK_PICTURE
     for OGG — see app/vp-cover.js). We never decode a whole song for
     it: imported files are read as a bounded blob slice, phone-library
     files as a bounded HTTP range (the Android bridge honours it).
     When a file carries no art, the app shows its built-in artwork.
     ============================================================ */
  var COVER_HEAD_BYTES = 4 * 1024 * 1024;   /* ID3v2 tags live at the front */
  var COVER_TAIL_BYTES = 4 * 1024 * 1024;   /* moov atoms may sit at the end */
  var COVER_STORE_MAX = 600 * 1024;         /* max chars of the stored data URL */
  var coverQueue = [], coverWorking = false;

  function looksMp4(song) {
    var n = String((song && (song.name || song.title)) || "").toLowerCase();
    return n.indexOf(".m4a") >= 0 || n.indexOf(".mp4") >= 0 || n.indexOf(".aac") >= 0;
  }

  /* Reads at most COVER_HEAD_BYTES from the start of the song. */
  function readCoverHead(song) {
    if (song.path && window.fetch) {
      return fetch(deviceAudioUrl(song.path), {
        headers: { Range: "bytes=0-" + (COVER_HEAD_BYTES - 1) }, cache: "no-store"
      }).then(function (res) {
        if (res.status !== 206 && res.status !== 200) return null;
        var cl = Number(res.headers.get("Content-Length")) || 0;
        if (res.status === 200 && cl > 8 * 1024 * 1024) return null;
        return res.arrayBuffer();
      }).catch(function () { return null; });
    }
    if (song.blob && song.blob.size) {
      var b = song.blob;
      return b.slice(0, Math.min(b.size, COVER_HEAD_BYTES)).arrayBuffer();
    }
    if (song.blob === null) {
      /* imported song whose bytes live in IndexedDB */
      return idbGetFile(song.id).then(function (f) {
        if (!f) return null;
        song.blob = f;
        return f.slice(0, Math.min(f.size || COVER_HEAD_BYTES, COVER_HEAD_BYTES)).arrayBuffer();
      });
    }
    return Promise.resolve(null);
  }

  /* MP4-only second chance: the moov atom (and with it the cover) can be
     at the END of the file. Never applied to other containers. */
  function readCoverTail(song) {
    if (!looksMp4(song)) return Promise.resolve(null);
    if (song.blob && song.blob.size) {
      var size = song.blob.size || 0;
      if (size <= COVER_HEAD_BYTES) return Promise.resolve(null);
      return song.blob.slice(Math.max(0, size - COVER_TAIL_BYTES)).arrayBuffer();
    }
    if (song.path && (song.size || 0) > COVER_HEAD_BYTES && window.fetch) {
      return fetch(deviceAudioUrl(song.path), {
        headers: { Range: "bytes=-" + (COVER_TAIL_BYTES - 1) }, cache: "no-store"
      }).then(function (res) {
        if (res.status !== 206 && res.status !== 200) return null;
        var cl = Number(res.headers.get("Content-Length")) || 0;
        if (res.status === 200 && cl > 8 * 1024 * 1024) return null;
        return res.arrayBuffer();
      }).catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function releaseCoverBlob(song) {
    if (song && song.id !== currentId && !song.path) song.blob = null;
  }

  function extractCoverFor(song) {
    if (!song || song.cover) return Promise.resolve(false);
    if (!window.VP || typeof window.VP.findCoverImage !== "function") return Promise.resolve(false);
    return readCoverHead(song).then(function (ab) {
      var img = null;
      if (ab && ab.byteLength > 16) {
        try { img = window.VP.findCoverImage(new Uint8Array(ab)); } catch (e) { img = null; }
      }
      if (img) return finishCover(song, img);
      return readCoverTail(song).then(function (ab2) {
        var img2 = null;
        if (ab2 && ab2.byteLength > 16) {
          try { img2 = window.VP.findCoverImage(new Uint8Array(ab2)); } catch (e) { img2 = null; }
        }
        releaseCoverBlob(song);
        return img2 ? finishCover(song, img2) : false;
      });
    }).catch(function () {
      releaseCoverBlob(song);
      return false;
    });
  }

  function finishCover(song, img) {
    var bytes = img && img.data;
    if (!bytes || bytes.length < 8) return Promise.resolve(false);
    return window.VP.normalizeCover(bytes, img.mime).then(function (url) {
      releaseCoverBlob(song);
      if (!url || url.length > COVER_STORE_MAX) return false;
      if (songById(song.id) !== song) return false;   /* removed meanwhile */
      song.cover = url;
      idbPut(cleanRec(song));
      renderHome(); renderSearch();
      if (openPlaylistId) renderPlaylistSongs();
      if (currentId === song.id) { updateNpArt(); pushMediaMeta(); }
      return true;
    }).catch(function () { return false; });
  }

  function queueCoverExtraction(ids) {
    if (!ids || !ids.length) return;
    for (var i = 0; i < ids.length; i++) {
      var s = songById(ids[i]);
      if (s && !s.cover && coverQueue.indexOf(s.id) < 0) coverQueue.push(s.id);
    }
    if (coverWorking) return;
    coverWorking = true;
    (function step() {
      var id = coverQueue.shift();
      if (!id) { coverWorking = false; return; }
      var s = songById(id);
      if (!s) { setTimeout(step, 50); return; }
      extractCoverFor(s).then(function () {
        setTimeout(step, 150);
      }).catch(function () { setTimeout(step, 150); });
    })();
  }

  function defaultCoverUrl() {
    return (window.VP && window.VP.DEFAULT_COVER) ? window.VP.DEFAULT_COVER : "";
  }

  /* One injected style carries the default artwork for every list row. */
  function injectDefaultCoverStyle() {
    if (!document.getElementById("vp-default-cover-style") && defaultCoverUrl()) {
      var st = document.createElement("style");
      st.id = "vp-default-cover-style";
      st.textContent = ".vp-default-art{background-image:url(\"" + defaultCoverUrl() + "\");" +
        "background-size:cover;background-position:center;}";
      try { document.head.appendChild(st); } catch (e) { /* ignore */ }
    }
  }

/* ============================================================
     Audio engine — streaming only

       <audio> element  →  MediaElementSource
                        →  AI voice engine (AudioWorklet, always on)
                        →  voice boost → compressor → 5-band EQ
                        →  master → analyser → output

     Nothing else is ever played: the music stem does not exist in
     this app. Because the element streams the file and the worklet
     works on 1024-sample frames, a 300 MB song costs the same
     memory as a 3 MB one — the old "decode the whole file into an
     AudioBuffer" path is gone, which is what used to crash the app
     on large files.

     The graph is fail-closed: the media source is connected ONLY to
     the AI node (startEngine() is the single place that wires it), so
     while the engine loads — or if it cannot start on a device — the
     song stays silent instead of playing unfiltered. There is no
     direct path, no filter fallback and no unity-mask bypass.
     ============================================================ */
  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null, master = null, analyser = null, comp = null, eqIn = null, voiceGain = null;
  var eqBands = [], freqData = null;
  var audioEl = null, mediaSrc = null, aiNode = null;
  var engineKind = "none";            /* "ai" | "starting" | "error" | "none" */
  var engineErrorReason = "";
  var engineWatchdog = 0;
  var engineInfo = null, engineStats = null;
  var mediaUrl = null, mediaCors = false;
  var loaded = false, playing = false, wantsPlay = false;
  var duration = 0, playbackRate = 1, volume = 80, muted = false;
  var aiStrength = "max", aiBoostDb = 6, aiDenoise = true;
  var audioOutput = "auto";           /* auto | speaker | earpiece | bluetooth | wired */
  var exportState = null;             /* set by the WAV export section */

  var ICON_PLAY = "M7.5 4.8v14.4L20 12z";
  var ICON_PAUSE = "M6.5 4h3.6v16H6.5zM13.9 4h3.6v16h-3.6z";

  /* ---- shared node builders ---- */
  function cGain(C, v) { var g = C.createGain(); g.gain.value = v; return g; }
  function dbToGain(db) { return Math.pow(10, (Number(db) || 0) / 20); }

  /* ============================================================
     Media element (streamed source)
     ============================================================ */
  function deviceAudioUrl(path) {
    return "https://vocalpure.local/audio?path=" + encodeURIComponent(path);
  }

  function ensureAudioEl() {
    if (audioEl) return audioEl;
    audioEl = document.createElement("audio");
    audioEl.setAttribute("playsinline", "");
    audioEl.preload = "auto";
    try { audioEl.setAttribute("aria-hidden", "true"); } catch (e) { /* ignore */ }
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    audioEl.addEventListener("play", function () {
      playing = true; wantsPlay = true; setPlayIcon(true); startVizLoop();
      /* pinned notification + uninterrupted playback (no-op in a browser) */
      nativeCall("requestAudioFocus");
      nativeCall("setPlaying", true);
      pushPlayState();
    });
    audioEl.addEventListener("pause", function () {
      playing = false; setPlayIcon(false); updateProgressUI();
      nativeCall("setPlaying", false);
      pushPlayState();
    });
    audioEl.addEventListener("ended", function () {
      playing = false; wantsPlay = false; setPlayIcon(false); onTrackEnded();
    });
    audioEl.addEventListener("ratechange", function () { saveSettings(); });
    audioEl.addEventListener("timeupdate", function () {
      if (!vizRaf) updateProgressUI();
      if (playing && hasNativeMedia()) pushPlayState();
    });
    audioEl.addEventListener("error", function () {
      if (!loaded) return;
      toast("This track could not be streamed — try another file.", "error");
    });
    try { mediaSrc = actx.createMediaElementSource(audioEl); } catch (e) { mediaSrc = null; }
    /* Fail-closed by design: the source is left UNCONNECTED here, so the song
       is silent until the AI voice engine is actually processing it. There is
       deliberately no direct mediaSrc → output path anywhere in this app —
       unfiltered music must never be audible, not even for a moment while the
       engine loads. startEngine() below is the only place that connects the
       source, and only to the AI node. */
    return audioEl;
  }

  function setMediaUrl(url, cors) {
    if (mediaUrl && mediaUrl !== url) {
      try { URL.revokeObjectURL(mediaUrl); } catch (e) { /* ignore */ }
      mediaUrl = null;
    }
    mediaCors = !!cors;
    try {
      if (cors) audioEl.crossOrigin = "anonymous";
      else { audioEl.removeAttribute("crossorigin"); audioEl.crossOrigin = null; }
    } catch (e) { /* ignore */ }
    if (url && url.indexOf("blob:") === 0) mediaUrl = url;
    audioEl.src = url;
    try { audioEl.load(); } catch (e) { /* ignore */ }
  }

  function sourceForSong(song) {
    if (song.path) return Promise.resolve({ url: deviceAudioUrl(song.path), cors: true });
    if (song.blob) return Promise.resolve({ url: URL.createObjectURL(song.blob), cors: false });
    return idbGetFile(song.id).then(function (b) {
      if (!b) return null;
      song.blob = b;
      return { url: URL.createObjectURL(b), cors: false };
    });
  }

  /* Keep exactly one song's bytes referenced in JS memory. */
  function dropOtherBlobs(keepId) {
    for (var i = 0; i < library.length; i++) {
      if (library[i].id !== keepId) library[i].blob = null;
    }
  }

  function prepareMedia(song) {
    return new Promise(function (resolve, reject) {
      if (!audioEl) { reject(new Error("audio output unavailable")); return; }
      sourceForSong(song).then(function (spec) {
        if (!spec || !spec.url) { reject(new Error("the audio data is missing")); return; }
        dropOtherBlobs(song.id);
        var settled = false;
        function cleanup() {
          audioEl.removeEventListener("loadedmetadata", onMeta);
          audioEl.removeEventListener("error", onErr);
        }
        function onMeta() {
          if (settled) return;
          settled = true; cleanup();
          resolve({ duration: isFinite(audioEl.duration) ? audioEl.duration : 0 });
        }
        function onErr() {
          if (settled) return;
          settled = true; cleanup();
          reject(new Error("the stream could not be opened"));
        }
        audioEl.addEventListener("loadedmetadata", onMeta);
        audioEl.addEventListener("error", onErr);
        setMediaUrl(spec.url, spec.cors);
        /* some containers report metadata late — never hang the UI on it */
        setTimeout(function () {
          if (settled) return;
          settled = true; cleanup();
          resolve({ duration: isFinite(audioEl.duration) ? audioEl.duration : 0 });
        }, 9000);
      }).catch(reject);
    });
  }

  /* ============================================================
     Native media bridge — the pinned foreground notification,
     audio focus and output routing live in the Android host.
     Every call is guarded: in a plain browser these are no-ops.
     ============================================================ */
  var nativeApi = (typeof window !== "undefined" && window.VocalPureAndroid) || null;

  function nativeCall(fn) {
    if (!nativeApi || typeof nativeApi[fn] !== "function") return undefined;
    try {
      return nativeApi[fn].apply(nativeApi, Array.prototype.slice.call(arguments, 1));
    } catch (e) { return undefined; }
  }

  function hasNativeMedia() {
    return !!(nativeApi && nativeApi.setPlayState && nativeApi.setNowPlayingMeta);
  }

  /* Track identity + thumbnail → the pinned notification (on change only). */
  function pushMediaMeta() {
    if (!hasNativeMedia()) return;
    var s = currentSong();
    if (!s) return;
    var b64 = "";
    if (s.cover && s.cover.indexOf("base64,") > 0) {
      b64 = s.cover.slice(s.cover.indexOf("base64,") + 7);
    }
    nativeCall("setNowPlayingMeta", s.title || "VocalPure", s.artist || "", b64);
  }

  /* Position ticks (~1 Hz) → MediaStyle position + play/pause icon. */
  function pushPlayState() {
    if (!hasNativeMedia()) return;
    if (!currentSong()) return;
    nativeCall("setPlayState", playing, Math.round(currentPos() * 1000),
      Math.round((duration || 0) * 1000), playbackRate);
  }

  function stopMediaService() {
    nativeCall("stopPlaybackNotification");
    nativeCall("setPlaying", false);
  }

  /* Audio output routing — the same control the notification exposes. */
  function doAudioRouting() {
    if (!nativeApi || typeof nativeApi.setAudioOutput !== "function") return;
    var want = audioOutput;
    var res;
    try { res = nativeApi.setAudioOutput(want); } catch (e) { return; }
    if (typeof res === "string" && res && res !== want) {
      /* the host fell back (e.g. Bluetooth not connected) */
      audioOutput = res;
      syncAudioOutputUI();
      saveSettings();
      toast("“" + OUTPUT_LABELS[want] + "” is not available — using " +
        OUTPUT_LABELS[audioOutput] + ".", "info");
    }
  }
  function applyAudioOutput(mode, opts) {
    if (AUDIO_OUTPUTS.indexOf(mode) < 0) mode = "auto";
    audioOutput = mode;
    doAudioRouting();
    syncAudioOutputUI();
    saveSettings();
    if (!opts || opts.silent !== true) {
      toast("Audio output: " + OUTPUT_LABELS[audioOutput] + ".", "success");
    }
  }
  function syncAudioOutputUI() {
    var sel = $("set-audio-output");
    if (sel && sel.value !== audioOutput) sel.value = audioOutput;
  }

  /* Commands that come back from the pinned notification / the host. */
  window.onNativeMediaAction = function (action) {
    try {
      if (action === "play") {
        if (!ensureCtx()) return;
        if (!loaded) {
          var ids = currentViewIds.length ? currentViewIds.slice() : library.map(function (s) { return s.id; });
          if (ids.length) playFromList(ids, 0);
          return;
        }
        if (!playing) startAt(currentPos());
      } else if (action === "pause") {
        pausePlayback();
      } else if (action === "next") {
        stepNext();
      } else if (action === "prev") {
        stepPrev();
      } else if (action === "focus:loss") {
        /* another app owns the speaker — pause so we never fight for focus.
           wantsPlay deliberately stays true, so a later focus gain resumes. */
        if (playing) pausePlayback(true);
      } else if (action === "focus:gain") {
        /* Android sends gain after a Bluetooth hand-off or a transient
           interruption. Resume only when the user had been playing before
           the hand-off; a manually paused song must remain paused. */
        if (wantsPlay && loaded && !playing) startAt(currentPos());
      } else if (action === "focus:duck") {
        /* Do not change the user's volume permanently. Android's focus
           callback is informational here; the system mixer performs ducking. */
      } else if (action.indexOf("output-sync:") === 0) {
        /* the notification cycled the output natively — mirror the state */
        var m = action.slice("output-sync:".length);
        if (AUDIO_OUTPUTS.indexOf(m) >= 0 && m !== audioOutput) {
          audioOutput = m;
          syncAudioOutputUI();
          saveSettings();
          toast("Audio output: " + OUTPUT_LABELS[m] + ".", "info");
        }
      } else if (action.indexOf("output:") === 0 && action.length > 7) {
        applyAudioOutput(action.slice(7));
      } else if (action.indexOf("seek:") === 0 && action.length > 5) {
        var ms = Number(action.slice(5));
        if (loaded && duration > 0 && isFinite(ms) && ms >= 0) {
          try { audioEl.currentTime = Math.min(ms / 1000, duration); } catch (e) { /* ignore */ }
          updateProgressUI();
        }
      } else if (action === "bt:connected") {
        if (audioOutput === "bluetooth") doAudioRouting();
        else toast("Bluetooth connected — playing in high-quality A2DP.", "success");
      } else if (action === "bt:disconnected") {
        if (audioOutput === "bluetooth") {
          audioOutput = "speaker";
          doAudioRouting();
          syncAudioOutputUI();
          saveSettings();
          toast("Bluetooth disconnected — switched to the loudspeaker.", "info");
        }
      } else if (action === "headset:unplugged") {
        if (playing) {
          pausePlayback();
          toast("Headset unplugged — playback paused.", "info");
        }
      } else if (action === "headset:plugged") {
        if (wantsPlay && loaded && !playing) startAt(currentPos());
      }
    } catch (e) { /* a native callback must never crash the page */ }
  };

  /* ============================================================
     The AI voice engine
     ============================================================ */
  function ensureCtx() {
    if (!AC) return false;
    if (!actx) {
      try { actx = new AC(); } catch (e) { return false; }
      comp = actx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 12; comp.ratio.value = 5;
      comp.attack.value = 0.004; comp.release.value = 0.2;
      voiceGain = cGain(actx, dbToGain(aiBoostDb));
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
      voiceGain.connect(comp);
      comp.connect(eqIn);
      prev.connect(master);
      master.connect(analyser);
      analyser.connect(actx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      applyEQ();
      applyVolume();
      applyVoiceBoost();
      ensureAudioEl();
      startEngine();
    }
    if (actx.state === "suspended") actx.resume().catch(function () { /* ignore */ });
    return true;
  }

  /**
   * Puts the engine into the failed state: playback stays silent (the source
   * is never connected around the AI node) and the UI shows exactly why, with
   * a way to retry. There is deliberately no weak "filter fallback" any more:
   * playing the music nearly unfiltered while claiming it was removed is
   * worse than saying plainly that the engine could not start.
   */
  function engineError(reason) {
    if (engineKind === "error") return;
    engineKind = "error";
    engineErrorReason = reason || "unknown error";
    if (engineWatchdog) { try { clearTimeout(engineWatchdog); } catch (e) { /* ignore */ } engineWatchdog = 0; }
    updateEngineLine(); updateNp();
    toast("AI voice engine unavailable — " + engineErrorReason, "error");
  }

  /**
   * Boots the AI separation worklet. The module is built at runtime from the
   * factory in app/vp-ai-engine.js and loaded through a blob: URL, so it works
   * from file:// inside the Android WebView without a second fetch.
   *
   * Fail-closed: until the AI node exists and is wired in, the media source
   * stays disconnected (silent). A watchdog converts a hung module load into
   * a visible error instead of endless unfiltered playback.
   */
  function startEngine() {
    if (engineKind === "ai" || engineKind === "starting" || !actx) return;
    engineKind = "starting";
    updateEngineLine(); updateNp();
    if (!mediaSrc) {
      engineError("the audio graph could not be created on this device.");
      return;
    }
    var api = window.VPAIEngine;
    if (!actx.audioWorklet || !api || typeof api.factory !== "function" || !window.Blob || !window.URL || !window.AudioWorkletNode) {
      engineError("this device has no AudioWorklet. Update Android System WebView (or Chrome) and try again — open Settings → “Re-learn song” to retry.");
      return;
    }
    var settled = false;
    function failOnce(reason) {
      if (settled) return;
      settled = true;
      engineError(reason);
    }
    if (engineWatchdog) { try { clearTimeout(engineWatchdog); } catch (e) { /* ignore */ } }
    engineWatchdog = setTimeout(function () {
      engineWatchdog = 0;
      failOnce("the AI module took too long to load (over 6 s). Open Settings → “Re-learn song” to retry.");
    }, 6000);
    try {
      var source = "(" + api.factory.toString() + ")();";
      var modUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
      actx.audioWorklet.addModule(modUrl).then(function () {
        if (settled) return;
        try { URL.revokeObjectURL(modUrl); } catch (e) { /* ignore */ }
        var node = null;
        try {
          node = new AudioWorkletNode(actx, "vp-ai-voice", {
            numberOfInputs: 1, numberOfOutputs: 1,
            outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit"
          });
        } catch (e) {
          failOnce("the AI voice node could not be created (" + (e && e.message ? e.message : "unknown error") + "). Open Settings → “Re-learn song” to retry.");
          return;
        }
        aiNode = node;
        aiNode.port.onmessage = onEngineMessage;
        /* The ONLY routing in this app: source → AI → voice chain. The
           argument-free disconnect() is used on purpose: old WebViews throw
           on the selective disconnect(node) form, which would otherwise leave
           a second, unfiltered path connected next to the engine. */
        try { mediaSrc.disconnect(); } catch (e) { /* ignore */ }
        try { aiNode.disconnect(); } catch (e) { /* ignore */ }
        try {
          mediaSrc.connect(aiNode);
          aiNode.connect(voiceGain);
        } catch (e) {
          failOnce("the audio graph could not be wired (" + (e && e.message ? e.message : "unknown error") + ").");
          return;
        }
        settled = true;
        if (engineWatchdog) { try { clearTimeout(engineWatchdog); } catch (e) { /* ignore */ } engineWatchdog = 0; }
        sendEngineParams();
        updateEngineLine(); updateNp();
        /* engineKind flips to "ai" when the worklet posts "ready" (or the
           first stats batch); until then playback stays silent-but-armed and
           starts sounding automatically the moment the engine is live. */
      }).catch(function (err) {
        failOnce("the AI module could not be loaded" + (err && err.message ? " (" + err.message + ")" : "") + ". Update Android System WebView (or Chrome), then open Settings → “Re-learn song” to retry.");
      });
    } catch (e) {
      failOnce("the AI engine could not start (" + (e && e.message ? e.message : "unknown error") + ").");
    }
  }

  function sendEngineParams() {
    if (!aiNode) return;
    try {
      aiNode.port.postMessage({
        t: "params",
        strength: aiStrength,
        gateOn: aiDenoise,
        capture: !!exportState
      });
    } catch (e) { /* ignore */ }
  }

  function onEngineMessage(e) {
    var d = (e && e.data) || {};
    if (d.t === "ready") {
      engineInfo = d;
      if (engineKind !== "ai") {
        engineKind = "ai";
        sendEngineParams();
        toast("AI voice engine ready — music is removed automatically.", "success");
      }
      updateEngineLine();
      updateNp();
      return;
    }
    if (d.t === "stats") { onEngineStats(d); return; }
    if (d.t === "pcm") { onCaptureChunk(d); return; }
  }

  /* ============================================================
     Live learning: the engine's own metrics become the song's
     profile, so a track that has been played once already shows
     what the AI measured about it.
     ============================================================ */
  var live = { id: null, frames: 0, voice: 0, cut: 0, n: 0, saved: 0 };

  function resetLive(song) {
    live.id = song ? song.id : null;
    live.frames = 0; live.voice = 0; live.cut = 0; live.n = 0; live.saved = 0;
  }

  function liveClarity(cutDb, voiceRatio) {
    var c = 32 + Math.min(46, Math.abs(cutDb) * 1.5) + Math.max(0, Math.min(22, (voiceRatio - 0.15) * 30));
    return Math.max(12, Math.min(99, Math.round(c)));
  }

  function onEngineStats(d) {
    engineStats = d;
    if (engineKind === "starting") {
      /* Stats flowing means the processor is alive even if "ready" was lost. */
      engineKind = "ai";
      updateEngineLine(); updateNp();
    }
    updateAIMeters(d);
    var song = currentSong();
    if (!song) return;
    if (live.id !== song.id) resetLive(song);
    live.frames += (d.frames || 0);
    live.voice += (d.voice || 0);
    live.cut += (d.cutDb || 0);
    live.n++;
    if (live.frames < 800 || live.n < 6) return;
    var vAvg = live.voice / live.n, cAvg = live.cut / live.n;
    var prof = {
      ai: true, live: true, engine: "vp-ai-v6",
      voice: Math.round(vAvg * 100) / 100,
      cutDb: Math.round(cAvg * 10) / 10,
      f0: Math.round(d.f0 || 0),
      clarity: liveClarity(cAvg, vAvg),
      at: Date.now()
    };
    song._profile = prof;
    if (Date.now() - live.saved > 15000) {
      live.saved = Date.now();
      idbPut(cleanRec(song));
      renderHome(); renderSearch();
    }
    updateEngineLine();
  }

  function updateAIMeters(d) {
    var voicePct = Math.round((d.voice || 0) * 100);
    var vf = $("np-meter-voice");
    if (vf) vf.style.width = Math.max(2, voicePct) + "%";
    var vv = $("np-voice-val");
    if (vv) vv.textContent = voicePct + "%";
    var cut = Math.abs(d.cutDb || 0);
    var cf = $("np-meter-cut");
    if (cf) cf.style.width = Math.min(100, cut * 2.6) + "%";
    var cv = $("np-cut-val");
    if (cv) cv.textContent = cut < 0.6 ? "0 dB" : "−" + Math.round(cut) + " dB";
    var lat = $("np-ai-latency");
    if (lat) lat.textContent = Math.round(d.latencyMs || 0) + " ms";
    var f0 = $("np-ai-pitch");
    if (f0) f0.textContent = d.f0 > 40 ? Math.round(d.f0) + " Hz" : "–";
    var st = $("np-ai-state");
    if (st) {
      st.textContent = !d.voice ? "starting…" :
        (d.voice > 0.55 ? "voice isolated" : (d.voice > 0.25 ? "tracking voice" : "music muted"));
    }
  }

  /* ============================================================
     Transport
     ============================================================ */
  function currentPos() {
    if (!audioEl) return 0;
    var p = audioEl.currentTime || 0;
    if (!isFinite(p) || p < 0) p = 0;
    if (duration > 0 && p > duration) p = duration;
    return p;
  }

  var lastEngineWarn = 0;
  function startAt(offset) {
    if (!ensureCtx() || !loaded || !audioEl) return;
    if (!mediaSrc) {
      /* Without a media source the element would play straight to the
         speakers, bypassing the engine — so refuse instead of leaking music. */
      toast("Audio output is unavailable on this device — playback blocked so unfiltered music never plays.", "error");
      return;
    }
    if (engineKind === "error" && Date.now() - lastEngineWarn > 8000) {
      lastEngineWarn = Date.now();
      toast("No sound: " + engineErrorReason, "error");
    }
    var d = duration || (isFinite(audioEl.duration) ? audioEl.duration : 0);
    offset = Math.max(0, Math.min(offset, Math.max(d - 0.05, 0)));
    try { if (Math.abs((audioEl.currentTime || 0) - offset) > 0.05) audioEl.currentTime = offset; } catch (e) { /* ignore */ }
    try { audioEl.playbackRate = playbackRate; } catch (e) { /* ignore */ }
    var pr = null;
    try { pr = audioEl.play(); } catch (e) { pr = null; }
    if (pr && typeof pr.catch === "function") {
      pr.catch(function () {
        playing = false; setPlayIcon(false);
        toast("Playback could not start — tap play again.", "error");
      });
    }
    startVizLoop();
  }

  function pausePlayback(preserveIntent) {
    if (!preserveIntent) wantsPlay = false;
    if (audioEl && !audioEl.paused) { try { audioEl.pause(); } catch (e) { /* ignore */ } }
  }

  function stopPlayback() {
    pausePlayback();
    if (audioEl) { try { audioEl.currentTime = 0; } catch (e) { /* ignore */ } }
    playing = false;
    setPlayIcon(false);
    updateProgressUI();
  }

  function unloadCurrent() {
    stopPlayback();
    loaded = false;
    duration = 0;
    wantsPlay = false;
    nativeCall("setPlaying", false);
    nativeCall("abandonAudioFocus");
    stopMediaService();
    if (audioEl) { try { audioEl.removeAttribute("src"); audioEl.load(); } catch (e) { /* ignore */ } }
    if (mediaUrl) { try { URL.revokeObjectURL(mediaUrl); } catch (e) { /* ignore */ } mediaUrl = null; }
    $("np-title").textContent = "Nothing playing";
    $("np-artist").textContent = "Add songs to get started";
    updateNpArt();
    updateProgressUI();
    drawViz();
  }

  function togglePlay() {
    if (!loaded) {
      var ids = currentViewIds.length ? currentViewIds.slice() : library.map(function (s) { return s.id; });
      if (!ids.length) { toast("Add songs first — tap ＋ in the top bar."); return; }
      playFromList(ids, 0);
      return;
    }
    if (!ensureCtx()) return;
    if (playing) pausePlayback();
    else startAt(duration && currentPos() >= duration - 0.15 ? 0 : currentPos());
  }

  function seekTo(ratio) {
    if (!loaded || !audioEl || !duration) return;
    ratio = Math.max(0, Math.min(1, ratio));
    if (exportState) stopExport(true);
    try { audioEl.currentTime = ratio * duration; } catch (e) { /* ignore */ }
    updateProgressUI();
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
  function applyVoiceBoost() {
    if (!voiceGain) return;
    var g = dbToGain(aiBoostDb);
    if (actx) {
      try { voiceGain.gain.setTargetAtTime(g, actx.currentTime, 0.05); return; } catch (e) { /* ignore */ }
    }
    voiceGain.gain.value = g;
  }

  /* ============================================================
     Queue / track loading
     The queue holds song ids only — never audio data.
     ============================================================ */
  var queue = [], qi = -1;
  var shuffle = false, repeatMode = "off";

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
    resetLive(song);
    markCurrentRow(); renderQueue(); updateNp();
    if (exportState) stopExport(true);
    prepareMedia(song).then(function (info) {
      if (my !== loadToken) return;
      stopPlayback();
      loaded = true;
      duration = info.duration || song.duration || 0;
      if (info.duration && Math.abs((song.duration || 0) - info.duration) > 0.5) {
        song.duration = info.duration;
        idbPut(cleanRec(song));
        renderHome(); renderSearch();
      }
      $("np-title").textContent = song.title;
      $("np-artist").textContent = song.artist + (song.path ? " · phone library" : " · imported");
      updateNpArt();
      pushMediaMeta();                 /* the pinned notification follows the queue */
      updateProgressUI();
      drawViz();
      updateEngineLine();
      updateNp();
      if (autoplay) { startAt(0); openNp(); }
      if (!song._profile) queueAnalysis([song.id]);
    }).catch(function (err) {
      if (my !== loadToken) return;
      loaded = false;
      duration = 0;
      setPlayIcon(false);
      toast("Could not play “" + song.title + "”" + (err && err.message ? " — " + err.message : "."), "error");
    });
  }

  function onTrackEnded() {
    if (exportState) { stopExport(true); return; }
    if (repeatMode === "one") { startAt(0); return; }
    if (qi >= 0 && qi < queue.length - 1) { qi++; loadSongById(queue[qi], true); return; }
    if (repeatMode === "all" && queue.length) { qi = 0; loadSongById(queue[qi], true); return; }
    playing = false;
    nativeCall("setPlaying", false);
    nativeCall("abandonAudioFocus");
    stopMediaService();
    updateProgressUI();
  }

  function stepNext() {
    if (!queue.length) { toast("Nothing in the queue yet."); return; }
    qi = (qi + 1) % queue.length;
    loadSongById(queue[qi], true);
  }
  function stepPrev() {
    if (loaded && currentPos() > 3) { startAt(0); return; }
    if (!queue.length) { toast("Nothing in the queue yet."); return; }
    qi = (qi - 1 + queue.length) % queue.length;
    loadSongById(queue[qi], true);
  }

  /* ============================================================
     AI controls (there is no mode / stem / music control here)
     ============================================================ */
  function strengthLabel(name) {
    var api = window.VPAIEngine;
    var s = api && api.strengths && api.strengths[name];
    return (s && s.label) || name;
  }

  function setAIStrength(name, opts) {
    /* The release UI calls the tightened Max preset “precision”. Keep the
       engine's four canonical preset names while making that explicit button
       select the exact same high-precision path as Max. */
    if (name === "precision") name = "max";
    if (AI_STRENGTHS.indexOf(name) < 0) name = "strong";
    aiStrength = name;
    sendEngineParams();
    updateAIUI();
    updateEngineLine();
    saveSettings();
    if (!opts || opts.silent !== true) toast("AI separation strength: " + strengthLabel(name) + ".");
  }

  function setAIBoost(db) {
    aiBoostDb = Math.max(0, Math.min(18, Math.round(Number(db) || 0)));
    applyVoiceBoost();
    updateAIUI();
    saveSettings();
  }

  function setAIDenoise(on) {
    aiDenoise = !!on;
    sendEngineParams();
    updateAIUI();
    saveSettings();
    toast(aiDenoise ? "Music-only parts are silenced completely." : "Music-only parts keep a quiet tail.");
  }

  function updateAIUI() {
    var btns = document.querySelectorAll(".ai-btn");
    for (var i = 0; i < btns.length; i++) {
      var buttonStrength = btns[i].getAttribute("data-ai");
      var on = buttonStrength === aiStrength ||
        (buttonStrength === "precision" && aiStrength === "max");
      btns[i].classList.toggle("is-active", on);
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    var sel = $("set-ai-strength");
    if (sel && sel.value !== aiStrength) sel.value = aiStrength;
    var b = $("np-voice-boost");
    if (b) b.value = String(aiBoostDb);
    var bv = $("np-voice-boost-val");
    if (bv) bv.textContent = "+" + aiBoostDb + " dB";
    var sb = $("set-ai-boost");
    if (sb) sb.value = String(aiBoostDb);
    var sbv = $("set-ai-boost-val");
    if (sbv) sbv.textContent = "+" + aiBoostDb + " dB";
    var sw = $("np-denoise");
    if (sw) { sw.classList.toggle("is-on", aiDenoise); sw.setAttribute("aria-checked", aiDenoise ? "true" : "false"); }
    var sw2 = $("set-ai-denoise");
    if (sw2) { sw2.classList.toggle("is-on", aiDenoise); sw2.setAttribute("aria-checked", aiDenoise ? "true" : "false"); }
  }

  function updateEngineLine() {
    var song = currentSong();
    var p = song ? song._profile : null;
    var label = engineKind === "ai" ? "AI voice isolation"
      : (engineKind === "error" ? "AI engine unavailable" : "Starting AI engine…");
    var strat = $("np-strategy");
    if (strat) strat.textContent = label;
    var detail = $("np-strategy-detail");
    if (detail) {
      if (engineKind === "error") {
        detail.textContent = engineErrorReason + " Playback stays silent so unfiltered music never plays.";
      } else if (!song) detail.textContent = "Add a song — the AI analyzes it while it plays and removes the music.";
      else if (engineKind !== "ai") detail.textContent = "Loading the on-device AI engine — sound starts automatically when it is ready.";
      else if (p && p.live) {
        detail.textContent = "voice " + Math.round((p.voice || 0) * 100) + "% of the time · music cut " +
          Math.abs(Math.round(p.cutDb || 0)) + " dB · clarity " + p.clarity + "%";
      } else if (p) {
        detail.textContent = "analysed on import: " + Math.round((p.centerRatio || 0) * 100) +
          "% of the voice band is centre-locked" + (p.stereo === false ? " · mono file" : "");
      } else {
        detail.textContent = "listening to this track — the engine refines its voice profile while it plays.";
      }
    }
    var el = $("engine-line");
    if (el) {
      if (engineKind === "error") {
        el.textContent = "⚠️ The AI engine could not start: " + engineErrorReason + " Playback stays silent so unfiltered music never plays.";
      } else if (engineKind === "ai" && p && p.live) {
        el.innerHTML = "AI: the music is <b>removed live</b> from the stream — voice detected " +
          Math.round((p.voice || 0) * 100) + "% of the time, music attenuated <b>" +
          Math.abs(Math.round(p.cutDb || 0)) + " dB</b>. There is no music mode: only the voice is played.";
      } else if (engineKind === "ai") {
        el.innerHTML = "AI engine <b>online</b> — it learns this exact track while it plays and removes the music automatically. Only the voice is ever played.";
      } else {
        el.innerHTML = "Starting the on-device AI engine… sound begins automatically once it is ready.";
      }
    }
    var st = $("set-ai-status");
    if (st) {
      if (engineKind === "error") {
        st.textContent = "Unavailable — " + engineErrorReason;
      } else if (engineKind === "ai") {
        st.textContent = "AI engine online" + (engineInfo
          ? " · " + Math.round(engineInfo.latencyMs || 0) + " ms latency · " + (engineInfo.fft || 1024) + "-point FFT · " + Math.round((engineInfo.sr || 48000) / 1000) + " kHz"
          : "");
      } else {
        st.textContent = "Starting…";
      }
    }
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
    var autoFlag = s._profile ? ' <em class="row-auto">✓ AI</em>' : "";
    var isCur = s.id === currentId;
    var artSpan = s.cover
      ? '<span class="song-cover" style="background-image:url(\'' + s.cover + '\');background-size:cover;background-position:center" aria-hidden="true"></span>'
      : '<span class="song-cover vp-default-art" aria-hidden="true"></span>';
    var html = '<li class="song-row' + (isCur ? " is-current" + (playing ? "" : " is-paused") : "") + '" data-id="' + escapeHtml(s.id) + '">' +
      '<button type="button" class="song-main" aria-label="Play ' + escapeHtml(s.title) + '">' +
      artSpan +
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
    for (var i = 0; i < n; i++) total += library[i].size || 0;
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
      unloadCurrent();
      currentId = null;
      s.blob = null;
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

  /* Now Playing artwork: the cover embedded in the file, or the app's
     built-in artwork when the file carries none. */
  function updateNpArt() {
    var s = currentSong();
    var art = $("np-art"), letter = $("np-art-letter");
    if (!art || !letter) return;
    var url = (s && s.cover) ? s.cover : defaultCoverUrl();
    if (url) {
      art.style.background = "";
      art.style.backgroundImage = "url(\"" + url + "\")";
      art.style.backgroundSize = "cover";
      art.style.backgroundPosition = "center";
    } else {
      var hue = coverHue(s ? s.title : "?");
      art.style.background = "linear-gradient(135deg, hsl(" + hue + ",62%,50%), hsl(" + ((hue + 50) % 360) + ",64%,34%))";
    }
    letter.textContent = "";
    letter.style.opacity = url ? "0" : "0.9";
  }

  function updateNp() {
    var s = currentSong();
    var chip = $("np-mode-chip");
    if (chip) {
      chip.textContent = engineKind === "error" ? "⚠️ AI unavailable"
        : (engineKind === "ai" ? (s ? "🎤 pure voice · AI" : "—") : "⏳ AI loading…");
    }
    var fav = $("np-fav");
    if (fav) fav.classList.toggle("is-fav", !!(s && s.favorite));
    var play = $("btn-play");
    if (play) play.disabled = !s;
    var exp = $("exp-voice");
    if (exp && !exportState) exp.disabled = !s;
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
     WAV export — the purified voice is *recorded* while the song
     plays (1× real time). Nothing is ever buffered as a whole:
     the worklet streams 16-bit PCM chunks and each chunk is
     appended straight to the output file (native bridge) or to a
     blob part list (browser). This is the only export path, so a
     two-hour file is as safe as a two-minute one.
     ============================================================ */
  function b64(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    return btoa(s);
  }

  function exportFileName(song) {
    var safe = String((song && song.title) || "voice").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "voice";
    var artist = String((song && song.artist) || "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40);
    return (artist && artist !== "Unknown artist" ? artist + " - " : "") + safe + " (pure voice).wav";
  }

  function wavHeader(sampleRate, channels, dataBytes) {
    var buf = new ArrayBuffer(44), v = new DataView(buf), o = 0;
    function wstr(s) { for (var i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); }
    function u32(x) { v.setUint32(o, x, true); o += 4; }
    function u16(x) { v.setUint16(o, x, true); o += 2; }
    var total = dataBytes > 0 ? 36 + dataBytes : 0x7ffff000;
    wstr("RIFF"); u32(total); wstr("WAVE"); wstr("fmt "); u32(16);
    u16(1); u16(channels); u32(sampleRate); u32(sampleRate * channels * 2);
    u16(channels * 2); u16(16); wstr("data"); u32(dataBytes > 0 ? dataBytes : 0x7ffff000);
    return new Uint8Array(buf);
  }

  function nativeWriter(name) {
    var api = window.VocalPureAndroid;
    if (!api || typeof api.writeFile !== "function") return null;
    return {
      write: function (u8, isLast) {
        try { return api.writeFile(name, u8 && u8.length ? b64(u8) : "", !!isLast); }
        catch (e) { return "error:" + (e && e.message ? e.message : "write failed"); }
      },
      finish: function (dataBytes) {
        if (typeof api.finishWav === "function") {
          try { return api.finishWav(name, dataBytes); } catch (e) { return "error:" + (e && e.message ? e.message : "finish failed"); }
        }
        return "ok";
      }
    };
  }

  function setExportUI(running) {
    var btn = $("exp-voice");
    if (btn) {
      btn.disabled = !currentSong();
      btn.textContent = running ? "⏹ Stop & save" : "⬇ Save pure voice (.wav)";
      btn.classList.toggle("is-recording", !!running);
    }
    var st = $("exp-status");
    if (st && !running) st.textContent = "";
  }

  function exportProgressText() {
    if (!exportState) return "";
    var secs = exportState.samples / (actx ? actx.sampleRate : 48000);
    var pct = duration > 0 ? Math.min(100, Math.round((secs / duration) * 100)) : 0;
    return "recording " + fmtTime(secs) + (duration > 0 ? " / " + fmtTime(duration) + " · " + pct + "%" : "");
  }

  function updateExportProgress() {
    var st = $("exp-status");
    if (st && exportState) st.textContent = exportProgressText();
  }

  function startExport() {
    if (exportState) { stopExport(false); return; }
    var song = currentSong();
    if (!song) { toast("Play a song first, then save its purified voice."); return; }
    if (!ensureCtx()) return;
    if (engineKind !== "ai" || !aiNode) {
      toast("Saving the purified voice needs the AI engine, which this device does not expose.", "error");
      return;
    }
    var name = exportFileName(song);
    exportState = {
      songId: song.id, name: name, samples: 0, parts: [], bytes: 0,
      native: nativeWriter(name), started: Date.now(), timer: 0, paused: false
    };
    var head = wavHeader(actx.sampleRate, 2, 0);
    if (exportState.native) {
      var res = exportState.native.write(head, false);
      if (typeof res === "string" && res.indexOf("error") === 0) {
        exportState = null;
        toast("Could not open the output file.", "error");
        return;
      }
    } else {
      exportState.header = head;
    }
    sendEngineParams();
    updateExportProgress();
    setExportUI(true);
    exportState.timer = setInterval(function () {
      updateExportProgress();
      if (!playing && exportState && !exportState.paused) {
        /* playback stopped (user or end of song) → wrap the file up */
        stopExport(true);
      }
    }, 500);
    toast("Recording the purified voice — the song plays in real time.", "info");
    startAt(0);
  }

  function onCaptureChunk(d) {
    if (!exportState) return;
    var buf = d.data;
    if (!buf) return;
    var u8 = new Uint8Array(buf);
    exportState.samples += (d.samples || (u8.length / 4)) | 0;
    exportState.bytes += u8.length;
    if (exportState.native) {
      var res = exportState.native.write(u8, false);
      if (typeof res === "string" && res.indexOf("error") === 0) {
        toast("Writing the file failed: " + res.slice(6), "error");
        stopExport(false);
      }
    } else {
      exportState.parts.push(u8);
      if (exportState.bytes > 220 * 1024 * 1024) {
        toast("Export is getting large — saving what was recorded so far.", "info");
        stopExport(true);
      }
    }
  }

  function downloadBlob(blob, filename) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { document.body.removeChild(a); } catch (e) { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      }, 5000);
      return true;
    } catch (e) { return false; }
  }

  function stopExport(automatic) {
    if (!exportState) return;
    var st = exportState;
    exportState = null;
    if (st.timer) clearInterval(st.timer);
    try { if (aiNode) aiNode.port.postMessage({ t: "params", capture: false, flushCapture: true }); } catch (e) { /* ignore */ }
    setExportUI(false);
    var secs = Math.round(st.samples / (actx ? actx.sampleRate : 48000));
    if (secs < 2) {
      toast("Export cancelled — nothing was saved.", "error");
      if (st.native) { try { st.native.write(new Uint8Array(0), true); } catch (e) { /* ignore */ } }
      return;
    }
    if (st.native) {
      var r = st.native.write(new Uint8Array(0), true);
      var res = st.native.finish(st.bytes);
      if (typeof res === "string" && res.indexOf("error") === 0) {
        toast("Export failed: " + res.slice(6), "error");
        return;
      }
      var path = (typeof r === "string" && r.indexOf("ok:") === 0) ? r.slice(3) : "";
      toast("Saved “" + st.name + "” (" + fmtTime(secs) + ")" + (path ? " to Music/VocalPure" : "") + ".", "success");
    } else {
      /* the streamed header used placeholder sizes — rebuild it with the real ones */
      var blob = new Blob([wavHeader(actx.sampleRate, 2, st.bytes)].concat(st.parts), { type: "audio/wav" });
      if (downloadBlob(blob, st.name)) toast("Export finished — check your downloads.", "success");
      else toast("Export failed.", "error");
    }
    if (automatic) updateExportProgress();
  }

/* ============================================================
     Import — files are stored as-is (no decode, no ArrayBuffer)
     ============================================================ */
  var MAX_FILE = 600 * 1024 * 1024;
  function looksAudio(f) {
    if (!f) return false;
    if (f.type && f.type.indexOf("audio") === 0) return true;
    if (/\.(mp3|wav|m4a|aac|ogg|opus|flac|wma|oga|weba|webm)$/i.test(f.name || "")) return true;
    if (!f.type || f.type === "application/octet-stream" || f.type === "application/x-zip-compressed") return true;
    return false;
  }

  /* Duration from metadata only — the media element reads the header, so no
     PCM is ever allocated for it. */
  function probeDuration(source) {
    return new Promise(function (resolve) {
      var el = document.createElement("audio");
      var url = null, done = false;
      function finish(d) {
        if (done) return;
        done = true;
        if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }
        el.removeAttribute("src");
        resolve(isFinite(d) && d > 0 ? d : 0);
      }
      el.addEventListener("loadedmetadata", function () { finish(el.duration); });
      el.addEventListener("error", function () { finish(0); });
      try {
        if (typeof source === "string") el.src = source;
        else { url = URL.createObjectURL(source); el.src = url; }
      } catch (e) { finish(0); return; }
      setTimeout(function () { finish(el.duration); }, 6000);
    });
  }

  function loadFiles(files) {
    if (!files || !files.length) return;
    var list = [], i;
    for (i = 0; i < files.length; i++) list.push(files[i]);
    var ok = 0, bad = 0, big = 0, idx = 0, newIds = [];
    function next() {
      if (idx >= list.length) {
        renderHome(); renderSearch(); renderPlaylists(); updateCounts();
        if (ok) toast("Added " + ok + " song" + (ok === 1 ? "" : "s") + " to your library.", "success");
        if (bad) toast(bad + " file(s) skipped (not audio or unreadable).", "error");
        if (big) toast(big + " file(s) were larger than " + Math.round(MAX_FILE / (1024 * 1024)) + " MB and were skipped.", "error");
        if (newIds.length) queueAnalysis(newIds);
        if (newIds.length) queueCoverExtraction(newIds);
        if (newIds.length && !currentId) playFromList(newIds, 0);
        return;
      }
      var f = list[idx++];
      if (!looksAudio(f)) { bad++; next(); return; }
      if (f.size > MAX_FILE) { big++; next(); return; }
      var meta = parseName(f.name);
      var rec = {
        id: uid(), title: meta.title, artist: meta.artist, name: f.name,
        duration: 0, blob: f, favorite: false, dateAdded: Date.now(),
        size: f.size || 0, path: null, _profile: null
      };
      library.push(rec);
      idbPut(cleanRec(rec));
      idbPutFile(rec.id, f);
      newIds.push(rec.id);
      ok++;
      renderHome(); renderSearch(); updateCounts();
      /* start the instant analysis + embedded-cover extraction right away —
         they do not need the last file's duration probe to finish */
      queueAnalysis([rec.id]);
      queueCoverExtraction([rec.id]);
      probeDuration(f).then(function (d) {
        if (d > 0) { rec.duration = d; idbPut(cleanRec(rec)); renderHome(); renderSearch(); }
        setTimeout(next, 20);
      });
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
            favorite: false,
            dateAdded: Date.now(),
            _profile: null,
            size: item.size || 0
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
          if (newIds.length) queueAnalysis(newIds);
          if (newIds.length) queueCoverExtraction(newIds);
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
     Appearance — background mode, themes, colors, wallpaper
     Saved per device, applied instantly, survives restarts.
     ============================================================ */
  var THEME_KEY = "vp-app-theme-v1";
  var THEMES = {
    midnight: { c1: "#2fe6c8", c2: "#3aa6ff", detail: "#f2c14e", light: false },
    ocean:    { c1: "#38bdf8", c2: "#6366f1", detail: "#f2c14e", light: false },
    sunset:   { c1: "#fb7185", c2: "#fb923c", detail: "#fde68a", light: false },
    royal:    { c1: "#c084fc", c2: "#6366f1", detail: "#f0abfc", light: false },
    forest:   { c1: "#34d399", c2: "#22d3ee", detail: "#fbbf24", light: false },
    light:    { c1: "#0ea5e9", c2: "#8b5cf6", detail: "#f59e0b", light: true }
  };
  var THEME_DEFAULTS = {
    theme: "midnight", bgMode: "gradient",
    c1: "#2fe6c8", c2: "#3aa6ff",
    wpOp: 60, wallpaper: ""
  };
  var appTheme = loadAppTheme();

  function loadAppTheme() {
    var t = {}, k;
    for (k in THEME_DEFAULTS) t[k] = THEME_DEFAULTS[k];
    try {
      var raw = localStorage.getItem(THEME_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (s) for (var k2 in t) {
        if (s[k2] !== undefined && s[k2] !== null) t[k2] = s[k2];
      }
    } catch (e) { /* defaults */ }
    if (!THEMES[t.theme] && t.theme !== "custom") t.theme = "midnight";
    if (["gradient", "minimal", "wallpaper"].indexOf(t.bgMode) < 0) t.bgMode = "gradient";
    if (!/^#[0-9a-fA-F]{6}$/.test(String(t.c1 || ""))) t.c1 = THEME_DEFAULTS.c1;
    if (!/^#[0-9a-fA-F]{6}$/.test(String(t.c2 || ""))) t.c2 = THEME_DEFAULTS.c2;
    t.wpOp = Math.max(10, Math.min(100, Math.round(Number(t.wpOp) || THEME_DEFAULTS.wpOp)));
    return t;
  }

  function saveAppTheme() {
    try {
      var copy = {};
      for (var k in appTheme) copy[k] = appTheme[k];
      if (typeof copy.wallpaper === "string" && copy.wallpaper.length > 900000) copy.wallpaper = "";
      localStorage.setItem(THEME_KEY, JSON.stringify(copy));
    } catch (e) { /* ignore */ }
  }

  function hexToRgb(hex, fallback) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return fallback;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, alpha, fallback) {
    var c = hexToRgb(hex, fallback || [47, 230, 200]);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")";
  }

  function applyAppTheme() {
    var root = document.documentElement;
    root.style.setProperty("--accent", appTheme.c1);
    root.style.setProperty("--grad-2", appTheme.c2);
    var preset = THEMES[appTheme.theme];
    var isLight = !!(preset && preset.light);
    root.style.setProperty("--accent-2", preset ? preset.detail : appTheme.c2);
    /* Theme-tinted background washes: the app shell, the Now Playing screen,
       the home hero and the top bar all paint from these, so picking a theme
       visibly recolors the whole background — not just the buttons. */
    root.style.setProperty("--glow-1", rgba(appTheme.c1, isLight ? 0.14 : 0.17, [47, 230, 200]));
    root.style.setProperty("--glow-2", rgba(appTheme.c2, isLight ? 0.12 : 0.15, [58, 166, 255]));
    root.style.setProperty("--glow-line", rgba(appTheme.c1, 0.38, [47, 230, 200]));
    /* In wallpaper mode the cards go translucent so the picture shows through
       (solid again in every other mode). */
    var wpActive = appTheme.bgMode === "wallpaper" && !!appTheme.wallpaper;
    root.style.setProperty("--surface", wpActive
      ? (isLight ? "rgba(255,255,255,0.86)" : "rgba(15,23,34,0.84)")
      : (isLight ? "#ffffff" : "#0f1722"));
    root.style.setProperty("--bg-2", wpActive
      ? (isLight ? "rgba(255,255,255,0.92)" : "rgba(11,17,27,0.90)")
      : (isLight ? "#ffffff" : "#0b111b"));
    document.body.setAttribute("data-bgmode", appTheme.bgMode);
    if (isLight) document.body.setAttribute("data-theme", "light");
    else document.body.removeAttribute("data-theme");
    var wp = $("app-wallpaper");
    if (wp) {
      if (appTheme.wallpaper) {
        wp.style.backgroundImage = 'url("' + appTheme.wallpaper + '")';
        wp.style.opacity = String(appTheme.wpOp / 100);
      } else {
        wp.style.backgroundImage = "none";
      }
    }
    syncThemeUI();
  }

  function syncThemeUI() {
    var btns = document.querySelectorAll("#theme-grid .theme");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("is-active", btns[i].getAttribute("data-theme") === appTheme.theme);
    }
    var bm = $("theme-bgmode");
    if (bm) bm.value = appTheme.bgMode;
    var c1 = $("theme-c1"), c2 = $("theme-c2");
    if (c1) c1.value = appTheme.c1;
    if (c2) c2.value = appTheme.c2;
    var op = $("theme-opacity"), opv = $("theme-opacity-val");
    if (op) op.value = String(appTheme.wpOp);
    if (opv) opv.textContent = appTheme.wpOp + "%";
  }

  function bindThemeUI() {
    document.querySelectorAll("#theme-grid .theme").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var name = btn.getAttribute("data-theme");
        if (!THEMES[name]) return;
        appTheme.theme = name;
        appTheme.c1 = THEMES[name].c1;
        appTheme.c2 = THEMES[name].c2;
        applyAppTheme(); saveAppTheme();
        toast("Theme applied: " + name.charAt(0).toUpperCase() + name.slice(1) + " — the whole background follows it.", "success");
      });
    });
    on($("theme-bgmode"), "change", function () {
      var sel = $("theme-bgmode");
      appTheme.bgMode = (sel && sel.value) || "gradient";
      if (appTheme.bgMode === "wallpaper" && !appTheme.wallpaper) {
        toast("Upload a wallpaper first — tap Upload below.");
        var fi = $("theme-file");
        if (fi) fi.click();
      }
      applyAppTheme(); saveAppTheme();
      var label = "Gradient glow";
      try { label = sel.options[sel.selectedIndex].text || label; } catch (e) { /* ignore */ }
      toast("Background: " + label + ".", "success");
    });
    on($("theme-c1"), "input", function () {
      appTheme.c1 = $("theme-c1").value;
      appTheme.theme = "custom";
      applyAppTheme(); saveAppTheme();
    });
    on($("theme-c2"), "input", function () {
      appTheme.c2 = $("theme-c2").value;
      appTheme.theme = "custom";
      applyAppTheme(); saveAppTheme();
    });
    on($("theme-opacity"), "input", function () {
      appTheme.wpOp = Math.max(10, Math.min(100, Number($("theme-opacity").value) || 60));
      applyAppTheme(); saveAppTheme();
    });
    on($("btn-theme-upload"), "click", function () {
      var fi = $("theme-file");
      if (fi) fi.click();
    });
    on($("theme-file"), "change", function () {
      var fi = $("theme-file");
      var f = fi && fi.files && fi.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type || "")) { toast("Please choose an image file.", "error"); fi.value = ""; return; }
      if (f.size > 8 * 1024 * 1024) { toast("Image is larger than 8 MB — pick a smaller one.", "error"); fi.value = ""; return; }
      var reader = new FileReader();
      reader.onload = function () {
        appTheme.wallpaper = String(reader.result || "");
        appTheme.bgMode = "wallpaper";
        applyAppTheme(); saveAppTheme();
        toast("Wallpaper applied.", "success");
      };
      reader.onerror = function () { toast("Could not read that image.", "error"); };
      reader.readAsDataURL(f);
      fi.value = "";
    });
    on($("btn-theme-remove"), "click", function () {
      appTheme.wallpaper = "";
      if (appTheme.bgMode === "wallpaper") appTheme.bgMode = "gradient";
      applyAppTheme(); saveAppTheme();
      toast("Wallpaper removed.");
    });
    on($("btn-theme-reset"), "click", function () {
      appTheme = {};
      for (var k in THEME_DEFAULTS) appTheme[k] = THEME_DEFAULTS[k];
      applyAppTheme(); saveAppTheme();
      toast("Appearance reset.", "success");
    });
  }

  /* ============================================================
     App updates — every user gets every release
     Compares the installed version against the published
     app-info.json and surfaces new releases in a home banner +
     a Settings row. Fully offline-safe: failures stay silent
     unless the check was started manually.
     ============================================================ */
  var UPDATE_URLS = [
    "https://raw.githubusercontent.com/y5747m-gif/moslem_day/main/app-info.json"
  ];
  var UPDATE_RECHECK_MS = 30 * 60 * 1000;
  var DISMISS_KEY = "vp-app-update-dismissed";
  var nativeVersion = "";
  var bundledVersion = "";
  var remoteInfo = null;

  function updNorm(v) {
    return String(v === undefined || v === null ? "" : v).trim().replace(/^[vV]/, "");
  }

  function updCmp(a, b) {
    var pa = updNorm(a).split(/[.\-+_]/), pb = updNorm(b).split(/[.\-+_]/);
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var xa = pa[i] === undefined ? "" : pa[i];
      var xb = pb[i] === undefined ? "" : pb[i];
      var na = parseInt(xa, 10), nb = parseInt(xb, 10);
      var aNum = !isNaN(na) && String(na) === xa;
      var bNum = !isNaN(nb) && String(nb) === xb;
      if (aNum && bNum) {
        if (na !== nb) return na > nb ? 1 : -1;
      } else if (xa !== xb) {
        if (xa === "") return 1;
        if (xb === "") return -1;
        return xa > xb ? 1 : -1;
      }
    }
    return 0;
  }

  function installedVersion() {
    return updNorm(nativeVersion || bundledVersion);
  }

  function fetchWithTimeout(url, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error("timeout")); }
      }, ms || 10000);
      fetch(url, { cache: "no-store" })
        .then(function (res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (!res.ok) reject(new Error("http " + res.status));
          else resolve(res.json());
        })
        .catch(function (e) {
          if (!done) { done = true; clearTimeout(timer); reject(e); }
        });
    });
  }

  function remoteVersionOf(info) {
    return updNorm((info && (info.versionPlain || info.version)) || "");
  }

  function dismissedVersion() {
    try { return updNorm(localStorage.getItem(DISMISS_KEY) || ""); }
    catch (e) { return ""; }
  }

  function setUpdateStatus(txt) {
    var el = $("update-status");
    if (el) el.textContent = txt;
  }

  function showUpdateAvailable(info) {
    remoteInfo = info;
    var ver = info.version || (info.versionPlain ? "v" + info.versionPlain : "");
    var first = (info.changelog && info.changelog.length) ? info.changelog[0] : "";
    var banner = $("update-banner");
    if (banner && remoteVersionOf(info) !== dismissedVersion()) {
      var t = $("update-title"), s = $("update-sub");
      if (t) t.textContent = ver + " available 🎉";
      if (s) s.textContent = first || "Tap Download to get the latest VocalPure.";
      banner.hidden = false;
    }
    var row = $("update-row");
    if (row) {
      row.hidden = false;
      var rt = $("update-row-title"), rs = $("update-row-sub");
      if (rt) rt.textContent = ver + " available";
      if (rs) rs.textContent = first || "Tap Download to get it.";
    }
    setUpdateStatus("Update " + ver + " is ready to download.");
  }

  function checkAppUpdates(manual) {
    if (!window.fetch) {
      if (manual) toast("Update check is not supported here.", "error");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      if (manual) toast("You're offline — connect to check for updates.", "error");
      else setUpdateStatus("Offline — will check when you're back online.");
      return;
    }
    if (manual) {
      toast("Checking for updates…");
      setUpdateStatus("Checking…");
    }
    var urls = UPDATE_URLS.slice();
    /* When the app is opened over http(s), the site copy is freshest. */
    try {
      if (window.location && /^https?:/.test(window.location.protocol)) urls.unshift("../app-info.json?t=" + Date.now());
    } catch (e) { /* ignore */ }
    (function tryNext(i) {
      if (i >= urls.length) {
        if (manual) {
          toast("Could not reach the update server.", "error");
          setUpdateStatus("Last check failed — will retry automatically.");
        }
        return;
      }
      fetchWithTimeout(urls[i], 10000).then(function (info) {
        if (!info || !remoteVersionOf(info)) { tryNext(i + 1); return; }
        var rv = remoteVersionOf(info);
        var iv = installedVersion();
        if (!iv || updCmp(rv, iv) > 0) {
          showUpdateAvailable(info);
          toast("Update " + (info.version || ("v" + rv)) + " available 🎉", manual ? "success" : undefined);
        } else {
          try { localStorage.removeItem(DISMISS_KEY); } catch (e) { /* ignore */ }
          var b = $("update-banner"); if (b) b.hidden = true;
          var r = $("update-row"); if (r) r.hidden = true;
          setUpdateStatus("You're on the latest version (v" + iv + ").");
          if (manual) toast("You're on the latest version.", "success");
        }
      }).catch(function () { tryNext(i + 1); });
    })(0);
  }

  function openUpdatePage() {
    var url = (remoteInfo && remoteInfo.downloadPage) ||
      "https://github.com/y5747m-gif/moslem_day";
    try {
      if (window.VocalPureAndroid && window.VocalPureAndroid.openUpdatePage) {
        window.VocalPureAndroid.openUpdatePage(url);
        return;
      }
    } catch (e) { /* fall through to browser */ }
    try { window.open(url, "_blank"); }
    catch (e) { window.location.href = url; }
  }

  function bindUpdateUI() {
    on($("btn-check-updates"), "click", function () { checkAppUpdates(true); });
    on($("btn-update-go"), "click", openUpdatePage);
    on($("btn-update-download"), "click", openUpdatePage);
    on($("btn-update-later"), "click", function () {
      var b = $("update-banner");
      if (b) b.hidden = true;
      try { localStorage.setItem(DISMISS_KEY, remoteVersionOf(remoteInfo)); } catch (e) { /* ignore */ }
      toast("Update dismissed — it stays available in Settings.");
    });
    window.addEventListener("online", function () { checkAppUpdates(false); });
  }

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

  /* settings — AI engine */
  on($("set-ai-strength"), "change", function () { setAIStrength($("set-ai-strength").value); });
  on($("set-ai-boost"), "input", function () { setAIBoost($("set-ai-boost").value); });
  on($("set-ai-denoise"), "click", function () { setAIDenoise(!aiDenoise); });
  on($("btn-ai-relearn"), "click", function () {
    if (engineKind === "error") {
      /* The button doubles as the engine retry when the engine failed. */
      if (aiNode) { try { aiNode.disconnect(); } catch (e) { /* ignore */ } aiNode = null; }
      engineKind = "none";
      engineInfo = null; engineStats = null;
      toast("Retrying the AI voice engine…");
      if (ensureCtx()) startEngine();
      else toast("Audio is not supported on this device.", "error");
      return;
    }
    if (engineKind !== "ai") { toast("The AI engine is still loading — try again in a moment."); return; }
    var s = currentSong();
    if (!s) { toast("Play a song first, then let the AI learn it again."); return; }
    s._profile = null;
    resetLive(s);
    idbPut(cleanRec(s));
    if (aiNode) { try { aiNode.port.postMessage({ t: "params", reset: true }); } catch (e) { /* ignore */ } }
    sendEngineParams();
    renderHome(); renderSearch();
    updateEngineLine();
    toast("AI learning restarted for this song.", "success");
  });
  on($("set-volume"), "input", function () {
    volume = Number($("set-volume").value) || 0;
    if (volume > 0 && muted) muted = false;
    applyVolume();
    saveSettings();
  });
  on($("set-rate"), "change", function () {
    playbackRate = Number($("set-rate").value) || 1;
    if (audioEl) { try { audioEl.playbackRate = playbackRate; } catch (e) { /* ignore */ } }
    saveSettings();
  });
  on($("set-audio-output"), "change", function () {
    applyAudioOutput($("set-audio-output").value);
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
    unloadCurrent();
    currentId = null;
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
    var dragging = false;
    function seekFromPointer(e) {
      var rect = prog.getBoundingClientRect();
      if (rect.width <= 0) return;
      var x = e.clientX;
      if (e.touches && e.touches[0]) x = e.touches[0].clientX;
      seekTo(Math.max(0, Math.min(1, (x - rect.left) / rect.width)));
    }
    /* Pointer events cover mouse, touch and stylus. Capture keeps seeking
       responsive even when the finger leaves the narrow progress bar. */
    prog.addEventListener("pointerdown", function (e) {
      if (!loaded || duration <= 0) return;
      dragging = true; prog.classList.add("is-dragging");
      try { prog.setPointerCapture(e.pointerId); } catch (ignore) {}
      seekFromPointer(e); e.preventDefault();
    });
    prog.addEventListener("pointermove", function (e) {
      if (dragging) { seekFromPointer(e); e.preventDefault(); }
    });
    prog.addEventListener("pointerup", function (e) {
      dragging = false; prog.classList.remove("is-dragging");
      try { prog.releasePointerCapture(e.pointerId); } catch (ignore) {}
    });
    prog.addEventListener("click", function (e) {
      if (!dragging) seekFromPointer(e);
    });
    prog.addEventListener("keydown", function (e) {
      if (!loaded || duration <= 0) return;
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

  /* AI engine controls (strength / voice boost / music-only silence) */
  document.querySelectorAll(".ai-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { setAIStrength(btn.getAttribute("data-ai")); });
  });
  on($("np-voice-boost"), "input", function () { setAIBoost($("np-voice-boost").value); });
  on($("np-denoise"), "click", function () { setAIDenoise(!aiDenoise); });

  /* export: record the purified voice while the song plays */
  on($("exp-voice"), "click", startExport);

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

  function init() {
    /* appearance first so the saved theme paints before anything else */
    applyAppTheme();
    injectDefaultCoverStyle();
    bindThemeUI();
    bindUpdateUI();
    loadSettings();
    volume = settings.volume;
    playbackRate = settings.rate || 1;
    aiStrength = settings.aiStrength;
    aiBoostDb = settings.aiBoost;
    aiDenoise = settings.aiDenoise;
    audioOutput = settings.audioOutput;
    syncAudioOutputUI();
    doAudioRouting();
    eqGains = settings.eq.slice();
    eqOn = !!settings.eqOn;
    eqPresetName = settings.eqPreset || "normal";
    shuffle = !!settings.shuffle;
    repeatMode = settings.repeat || "off";

    $("set-volume").value = String(volume);
    syncVolumeUI();
    $("set-rate").value = String(playbackRate);
    $("btn-shuffle").classList.toggle("is-active", shuffle);
    $("btn-shuffle").setAttribute("aria-pressed", shuffle ? "true" : "false");
    $("btn-repeat").classList.toggle("is-active", repeatMode !== "off");
    $("btn-repeat").setAttribute("aria-pressed", repeatMode !== "off" ? "true" : "false");
    updateEqUI();
    updateAIUI();
    setExportUI(false);

    /* version + changelog: native bridge first, bundled app-info.json as
       fallback (fetch, then XHR for older WebViews) */
    var versionSet = false;
    function applyVersion(txt) {
      if (versionSet) return;
      versionSet = true;
      var el = $("set-version");
      if (el) el.textContent = txt;
    }
    if (window.VocalPureAndroid && window.VocalPureAndroid.appInfo) {
      try {
        var bridgeInfo = JSON.parse(window.VocalPureAndroid.appInfo());
        if (bridgeInfo.versionName) {
          nativeVersion = String(bridgeInfo.versionName);
          applyVersion("v" + bridgeInfo.versionName);
        }
      } catch (e) { /* fall through */ }
    }
    function loadAppInfo() {
      function onInfo(info) {
        if (info && (info.versionPlain || info.version)) {
          bundledVersion = String(info.versionPlain || info.version);
        }
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

    /* Build the audio graph right away so the AI engine is warm before the
       first tap (streaming, so this allocates a few buffers, nothing else). */
    try { ensureCtx(); } catch (e) { /* ignore */ }
    updateEngineLine();

    idbAll().then(function (recs) {
      library = (recs || []).map(function (r) {
        return {
          id: r.id, title: r.title || "Unknown", artist: r.artist || "Unknown artist",
          name: r.name || r.title || "Unknown", duration: r.duration || 0,
          blob: null, favorite: !!r.favorite, dateAdded: r.dateAdded || 0,
          _profile: r.profile || null, path: r.path || null, size: r.size || 0,
          cover: (typeof r.cover === "string" && r.cover.length <= COVER_STORE_MAX) ? r.cover : null
        };
      }).filter(function (r) { return r.id; });
      renderHome(); renderSearch(); renderPlaylists(); updateCounts();
      updatePermissionUI();
      if (library.length) {
        toast("Restored " + library.length + " song" + (library.length === 1 ? "" : "s") + " from your library.", "success");
        /* songs imported before this version may still be missing a profile */
        var pending = library.filter(function (s) { return !s._profile; }).map(function (s) { return s.id; });
        if (pending.length) setTimeout(function () { queueAnalysis(pending); }, 1500);
        /* songs imported before this version have no extracted cover yet */
        var noCover = library.filter(function (s) { return !s.cover; }).map(function (s) { return s.id; });
        if (noCover.length) setTimeout(function () { queueCoverExtraction(noCover); }, 2500);
      }
    }).catch(function () { idbFailed = true; });

    updatePermissionUI();
    if (window.VocalPureAndroid && window.VocalPureAndroid.hasStoragePermission) {
      var granted = false;
      try { granted = window.VocalPureAndroid.hasStoragePermission(); } catch (e) { granted = false; }
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

    /* live updates: first check shortly after launch, then periodically */
    setTimeout(function () { checkAppUpdates(false); }, 4000);
    setInterval(function () { checkAppUpdates(false); }, UPDATE_RECHECK_MS);

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

    /* keep the pinned notification's position readout fresh (~1 Hz) */
    setInterval(function () {
      if (playing && hasNativeMedia()) pushPlayState();
    }, 1000);

    /* a seek/an unload during an export must not leave a half file behind */
    window.addEventListener("beforeunload", function () {
      if (exportState) stopExport(true);
      nativeCall("setPlaying", false);
    });
  }

  init();
})();
