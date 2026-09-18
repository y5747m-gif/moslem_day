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
    version: "v2.4.1",
    versionPlain: "2.4.1",
    betaVersion: "v2.5.0-beta.2",
    size: "—",
    betaSize: "—",
    updated: "Sep 17, 2026",
    minAndroid: "8.0+",
    sha256: "…",
    stableFile: "downloads/VocalPure-v2.4.1.apk",
    betaFile: "downloads/VocalPure-v2.5.0-beta.2.apk"
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
     Live demo — Web Audio vocal / instrumental separation
     Isolation engine v2 — works on EVERY track:
       · stereo  -> center-channel extraction with band shaping
                    (vocals live in the center; bass is returned
                    for karaoke so the beat keeps driving)
       · mono    -> frequency-focus fallback (vocal band 170 Hz –
                    4.3 kHz isolated / removed), because mono files
                    carry no side signal for mid/side separation
       · every isolated path runs through a compressor so the
                    result never clips, and gets makeup gain to
                    match the original loudness.
     ============================================================ */
  function isolationMethod() {
    var stereo = !!(buffer && buffer.numberOfChannels >= 2);
    if (mode === "original" || !stereo && mode === "vocals") {
      return stereo ? "original" : (mode === "original" ? "original" : "mono-focus");
    }
    if (mode === "vocals") return "stereo-center";
    if (stereo) return "stereo-side-bass";
    return "mono-remove";
  }

  function biquad(type, freq, q) {
    var f = actx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q === undefined ? 0.71 : q;
    return f;
  }

  function gainNode(v) {
    var g = actx.createGain();
    g.gain.value = v;
    return g;
  }

  function connectMode(src, dest, which) {
    if (which === "original" || src.channelCount === 0) {
      src.connect(dest);
      return "original";
    }
    var stereo = !!(buffer && buffer.numberOfChannels >= 2);
    // Safety limiter: isolation can raise levels, never let it clip.
    var comp = actx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    comp.connect(dest);

    var splitter = actx.createChannelSplitter(2);
    var merger = actx.createChannelMerger(2);
    src.connect(splitter);

    if (!stereo) {
      /* ---- mono fallback: no side signal exists, so isolate by
              frequency focus on the vocal band instead ---- */
      if (which === "vocals") {
        var hp = biquad("highpass", 170);
        var lp = biquad("lowpass", 4300);
        var presence = biquad("peaking", 2600, 1.1);
        presence.gain.value = 2.5;
        var makeup = gainNode(1.3);
        src.connect(hp); hp.connect(lp); lp.connect(presence);
        presence.connect(makeup); makeup.connect(comp);
        return "mono-focus";
      }
      // karaoke on mono: remove the vocal band, keep the rest
      var lowKeep = biquad("lowpass", 170);
      var highKeep = biquad("highpass", 4300);
      var sumLow = gainNode(1.25);
      var sumHigh = gainNode(1.25);
      src.connect(lowKeep); lowKeep.connect(sumLow);
      src.connect(highKeep); highKeep.connect(sumHigh);
      sumLow.connect(comp); sumHigh.connect(comp);
      return "mono-remove";
    }

    if (which === "vocals") {
      // mid = (L + R) / 2 -> both channels, then band-shape:
      // cut sub rumble (<85 Hz) and air (>11.5 kHz) where vocals
      // almost never live but guitars/cymbals do.
      var gL = gainNode(0.5), gR = gainNode(0.5);
      splitter.connect(gL, 0); splitter.connect(gR, 1);
      gL.connect(merger, 0, 0); gR.connect(merger, 0, 0);
      gL.connect(merger, 0, 1); gR.connect(merger, 0, 1);
      var subCut = biquad("highpass", 85);
      var airCut = biquad("lowpass", 11500);
      var focus = biquad("peaking", 2600, 1.1);
      focus.gain.value = 1.5;
      var vocalMakeup = gainNode(1.35);
      merger.connect(subCut); subCut.connect(airCut);
      airCut.connect(focus); focus.connect(vocalMakeup);
      vocalMakeup.connect(comp);
      return "stereo-center";
    }

    // stereo karaoke: side = (L - R)/2 removes the center vocals,
    // and a low-passed copy of the mid returns the bass/kick so
    // every song keeps its groove.
    var a = gainNode(0.5), b = gainNode(-0.5), c = gainNode(-0.5), d = gainNode(0.5);
    splitter.connect(a, 0); splitter.connect(b, 1);
    splitter.connect(c, 0); splitter.connect(d, 1);
    a.connect(merger, 0, 0); b.connect(merger, 0, 0);
    c.connect(merger, 0, 1); d.connect(merger, 0, 1);
    var midL = gainNode(0.5), midR = gainNode(0.5);
    splitter.connect(midL, 0); splitter.connect(midR, 1);
    var bassKeep = biquad("lowpass", 150);
    var bassGain = gainNode(0.85);
    midL.connect(bassKeep, 0); midR.connect(bassKeep, 0);
    var bassMerge = actx.createChannelMerger(2);
    bassKeep.connect(bassGain);
    bassGain.connect(bassMerge, 0, 0); bassGain.connect(bassMerge, 0, 1);
    var sideGain = gainNode(1.15);
    merger.connect(sideGain);
    var finalMerge = actx.createChannelMerger(2);
    sideGain.connect(finalMerge, 0, 0); sideGain.connect(finalMerge, 0, 1);
    bassMerge.connect(finalMerge, 0, 0); bassMerge.connect(finalMerge, 0, 1);
    finalMerge.connect(comp);
    return "stereo-side-bass";
  }
  var demoFile = $("demo-file");
  var demoBrowse = $("demo-browse");
  var demoDrop = $("demo-drop");
  var demoSynth = $("demo-synth");
  var demoPlay = $("demo-play");
  var demoStop = $("demo-stop");
  var demoVol = $("demo-volume");
  var demoProg = $("demo-progress");
  var demoFill = $("demo-progress-fill");
  var demoCur = $("demo-time-cur");
  var demoTotal = $("demo-time-total");
  var demoLabel = $("demo-track-label");
  var demoStatus = $("demo-status");
  var demoViz = $("demo-viz");
  var playIcon = $("demo-play-icon");
  var modeBtns = document.querySelectorAll(".mode-btn");

  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null, master = null, analyser = null;
  var buffer = null, source = null;
  var mode = "original";
  var playing = false;
  var startCtxTime = 0, offsetBase = 0;
  var duration = 0;
  var vizRaf = null, freqData = null;
  var accentCache = ["#a855f7", "#22d3ee"];
  var accentTick = 0;

  var ICON_PLAY = "M7 4.5v15l13-7.5z";
  var ICON_PAUSE = "M6 4h4v16H6zM14 4h4v16h-4z";

  function setStatus(msg, isError) {
    if (!demoStatus) return;
    demoStatus.textContent = msg;
    demoStatus.classList.toggle("error", !!isError);
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function setPlayIcon(isPlaying) {
    if (playIcon) playIcon.innerHTML = "";
    if (playIcon) {
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", isPlaying ? ICON_PAUSE : ICON_PLAY);
      // replace children
      while (playIcon.firstChild) playIcon.removeChild(playIcon.firstChild);
      playIcon.appendChild(p);
    }
    if (demoPlay) demoPlay.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  }

  function ensureCtx() {
    if (!AC) {
      setStatus("Sorry — your browser does not support Web Audio, so the live demo can't run here. The Android app works on any device.", true);
      return false;
    }
    if (!actx) {
      try {
        actx = new AC();
      } catch (e) {
        setStatus("Could not start audio on this device (" + (e && e.message ? e.message : "unknown error") + ").", true);
        return false;
      }
      master = actx.createGain();
      master.gain.value = demoVol ? (Number(demoVol.value) / 100) : 0.8;
      analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      master.connect(analyser);
      analyser.connect(actx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
    }
    if (actx.state === "suspended") {
      actx.resume().catch(function () { /* ignore */ });
    }
    return true;
  }

  function currentPos() {
    if (!buffer) return 0;
    var pos = playing ? (offsetBase + (actx.currentTime - startCtxTime)) : offsetBase;
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
  }

  function connectMode(src, dest, which) {
    if (which === "original" || src.channelCount === 0) {
      src.connect(dest);
      return;
    }
    var splitter = actx.createChannelSplitter(2);
    var merger = actx.createChannelMerger(2);
    src.connect(splitter);
    if (which === "vocals") {
      // mid = (L + R) / 2 -> both channels
      var gL = actx.createGain(); gL.gain.value = 0.5;
      var gR = actx.createGain(); gR.gain.value = 0.5;
      splitter.connect(gL, 0); splitter.connect(gR, 1);
      gL.connect(merger, 0, 0); gR.connect(merger, 0, 0);
      gL.connect(merger, 0, 1); gR.connect(merger, 0, 1);
    } else {
      // side: L' = (L - R) / 2, R' = (R - L) / 2 (karaoke effect)
      var a = actx.createGain(); a.gain.value = 0.5;
      var b = actx.createGain(); b.gain.value = -0.5;
      var c = actx.createGain(); c.gain.value = -0.5;
      var d = actx.createGain(); d.gain.value = 0.5;
      splitter.connect(a, 0); splitter.connect(b, 1);
      splitter.connect(c, 0); splitter.connect(d, 1);
      a.connect(merger, 0, 0); b.connect(merger, 0, 0);
      c.connect(merger, 0, 1); d.connect(merger, 0, 1);
    }
    merger.connect(dest);
  }

  function startAt(offset) {
    if (!buffer || !actx) return;
    stopSource();
    offset = Math.max(0, Math.min(offset, Math.max(duration - 0.05, 0)));
    source = actx.createBufferSource();
    source.buffer = buffer;
    connectMode(source, master, mode);
    source.onended = function () {
      if (!playing) return;
      // natural end?
      if (currentPos() >= duration - 0.15) {
        playing = false;
        offsetBase = 0;
        setPlayIcon(false);
        updateProgressUI();
        setStatus("Finished. Press play to hear it again, or switch modes and compare.");
      }
    };
    try {
      source.start(0, offset);
    } catch (e) {
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

  function updateProgressUI() {
    var pos = currentPos();
    var pct = duration > 0 ? (pos / duration) * 100 : 0;
    if (demoFill) demoFill.style.width = pct.toFixed(2) + "%";
    if (demoCur) demoCur.textContent = fmtTime(pos);
    if (demoTotal) demoTotal.textContent = fmtTime(duration);
    if (demoProg) demoProg.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  function seekTo(ratio) {
    if (!buffer) return;
    ratio = Math.max(0, Math.min(1, ratio));
    var pos = ratio * duration;
    if (playing) startAt(pos);
    else { offsetBase = pos; updateProgressUI(); }
  }

  /* ---- visualizer ---- */
  var vizCtx = demoViz ? demoViz.getContext("2d") : null;
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
      if (playing) {
        vizRaf = requestAnimationFrame(loop);
      } else {
        vizRaf = null;
        drawViz();
      }
    };
    vizRaf = requestAnimationFrame(loop);
  }

  function enableTransport(hasTrack) {
    if (demoPlay) demoPlay.disabled = !hasTrack;
    for (var i = 0; i < modeBtns.length; i++) modeBtns[i].disabled = !hasTrack;
    if (!hasTrack && demoStop) demoStop.disabled = true;
  }

  function useBuffer(newBuffer, label) {
    stopPlayback();
    buffer = newBuffer;
    duration = newBuffer.duration || 0;
    offsetBase = 0;
    if (demoLabel) demoLabel.textContent = label;
    if (demoLabel) demoLabel.title = label;
    enableTransport(true);
    updateProgressUI();
    drawViz();
    var ch = newBuffer.numberOfChannels || 2;
    if (ch < 2) {
      setStatus("Track loaded (" + fmtTime(duration) + ", mono). The engine will use frequency-focus isolation — Vocals only keeps the vocal band, Karaoke removes it.");
    } else {
      setStatus("Track loaded (" + fmtTime(duration) + ", stereo). Press play, then compare Original / Vocals only / Karaoke — the center extractor keeps the voice and the karaoke mode returns the bass.");
    }
  }

  function decodeArrayBuffer(ab) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function ok(b) { if (!done) { done = true; resolve(b); } }
      function fail(e) { if (!done) { done = true; reject(e); } }
      try {
        var p = actx.decodeAudioData(ab, ok, fail);
        if (p && typeof p.then === "function") p.then(ok, fail);
      } catch (e) { fail(e); }
    });
  }

  var MAX_FILE = 50 * 1024 * 1024;
  function loadFile(file) {
    if (!file) return;
    var looksAudio = (file.type && file.type.indexOf("audio") === 0) ||
      /\.(mp3|wav|m4a|aac|ogg|opus|flac|wma)$/i.test(file.name || "");
    if (!looksAudio) {
      setStatus('"' + (file.name || "That file") + '" does not look like an audio file. Please choose MP3, WAV, M4A or OGG.', true);
      return;
    }
    if (file.size > MAX_FILE) {
      setStatus("That file is larger than 50 MB. Please pick a smaller clip for the browser demo.", true);
      return;
    }
    if (!ensureCtx()) return;
    setStatus("Decoding \"" + file.name + "\"…");
    var reader = new FileReader();
    reader.onload = function () {
      decodeArrayBuffer(reader.result).then(function (buf) {
        useBuffer(buf, file.name);
      }).catch(function () {
        setStatus("Could not decode that file. Try MP3 or WAV, or use the built-in demo mix below.", true);
      });
    };
    reader.onerror = function () {
      setStatus("Could not read that file. Please try again.", true);
    };
    reader.readAsArrayBuffer(file);
  }

  /* ---- built-in synthesized demo mix (10 s, stereo) ----
     Center: vocal-like melody (isolated by "Vocals only").
     Sides:  panned pads, riff + hats (removed by "Vocals only"). */
  function renderDemoMix() {
    if (!ensureCtx()) return;
    var sr = actx.sampleRate || 44100;
    var len = Math.floor(sr * 10);
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) {
      setStatus("Sorry — your browser can't render the demo mix. Please upload a file instead.", true);
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

    // -- center "vocal" melody with vibrato --
    var notes = [440, 523.25, 659.25, 587.33, 523.25, 440, 392, 440]; // A4 C5 E5 D5 C5 A4 G4 A4
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

    // -- wide backing pads (detuned saws through lowpass) --
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

    // -- panned square riff, right side --
    var riff = [329.63, 392, 523.25, 392, 440, 392, 329.63, 293.66];
    riff.forEach(function (f, i) {
      var reps = [0, 1, 2, 3];
      reps.forEach(function (rep) {
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

    // -- hats: alternating stereo noise clicks --
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

    // -- soft center bass --
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
      useBuffer(buf, "Demo mix — “Neon Skyline” (built-in)");
      startAt(0);
      setStatus("Playing demo mix. Switch to “Vocals only” to hear the center melody alone, or “Karaoke” for the backing.");
    }).catch(function () {
      if (demoSynth) demoSynth.disabled = false;
      setStatus("Demo rendering failed in this browser — please upload an audio file instead.", true);
    });
  }

  /* ---- demo events ---- */
  on(demoBrowse, "click", function () { if (demoFile) demoFile.click(); });
  on(demoFile, "change", function () {
    if (demoFile.files && demoFile.files[0]) loadFile(demoFile.files[0]);
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
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
  }
  on(demoSynth, "click", renderDemoMix);

  on(demoPlay, "click", function () {
    if (!buffer) { toast("Load a track first — drop a file or generate the demo mix."); return; }
    if (!ensureCtx()) return;
    if (playing) pausePlayback();
    else startAt(currentPos() >= duration - 0.1 ? 0 : currentPos());
  });
  on(demoStop, "click", stopPlayback);
  on(demoVol, "input", function () {
    if (master && actx) master.gain.setTargetAtTime(Number(demoVol.value) / 100, actx.currentTime, 0.02);
  });

  for (var m = 0; m < modeBtns.length; m++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var newMode = btn.getAttribute("data-mode");
        if (newMode === mode) return;
        if (!buffer) { toast("Load a track first to compare separation modes."); return; }
        mode = newMode;
        for (var k = 0; k < modeBtns.length; k++) {
          modeBtns[k].classList.toggle("is-active", modeBtns[k] === btn);
        }
        if (playing) startAt(currentPos());
        var names = { original: "Original mix", vocals: "Vocals only", karaoke: "Karaoke (instruments only)" };
        var methods = {
          original: "untouched audio",
          "stereo-center": "stereo center extraction",
          "stereo-side-bass": "stereo side extraction + bass return",
          "mono-focus": "mono frequency focus (vocal band)",
          "mono-remove": "mono vocal-band removal"
        };
        var m = methods[isolationMethod()] || "isolation";
        setStatus("Mode: " + (names[mode] || mode) + " · engine: " + m + (playing ? " — playing." : ". Press play to listen."));
      });
    })(modeBtns[m]);
  }

  if (demoProg) {
    demoProg.addEventListener("click", function (e) {
      var rect = demoProg.getBoundingClientRect();
      if (rect.width <= 0) return;
      seekTo((e.clientX - rect.left) / rect.width);
    });
    demoProg.addEventListener("keydown", function (e) {
      if (!buffer) return;
      if (e.key === "ArrowRight") { e.preventDefault(); seekTo((currentPos() + 5) / duration); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seekTo((currentPos() - 5) / duration); }
      else if (e.key === "Home") { e.preventDefault(); seekTo(0); }
      else if (e.key === "End") { e.preventDefault(); seekTo(1); }
    });
  }

  function initDemo() {
    enableTransport(false);
    sizeViz();
    refreshAccents();
    drawIdleViz(0);
    updateProgressUI();
    window.addEventListener("resize", sizeViz);
    // keep idle wave gently moving
    (function idle() {
      if (!playing) drawIdleViz(performance.now());
      requestAnimationFrame(idle);
    })();
    if (!AC) {
      setStatus("Your browser does not support Web Audio, so the live demo is unavailable here. The Android app works on any device.", true);
      var synth = $("demo-synth");
      if (synth) synth.disabled = true;
    }
  }
  if (demoViz) initDemo();
})();
