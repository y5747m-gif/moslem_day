/* ============================================================
   VocalPure — animated background + Background Studio customizer
   Vanilla JS, no dependencies. Settings persist in localStorage.
   ============================================================ */
(function () {
  "use strict";

  var STORAGE_KEY = "vocalpure-bg-v1";

  var PRESETS = {
    nebula:   { c1: "#a855f7", c2: "#3b82f6", c3: "#22d3ee" },
    midnight: { c1: "#22d3ee", c2: "#1e3a8a", c3: "#818cf8" },
    royal:    { c1: "#c084fc", c2: "#6d28d9", c3: "#f0abfc" },
    abyss:    { c1: "#38bdf8", c2: "#0ea5e9", c3: "#6366f1" },
    sunset:   { c1: "#f472b6", c2: "#8b5cf6", c3: "#fb923c" },
    aurora:   { c1: "#34d399", c2: "#3b82f6", c3: "#a78bfa" }
  };

  var DEFAULTS = {
    preset: "nebula",
    animated: true,
    links: true,
    particles: 110,
    speed: 100,      // percent (0-300)
    glow: 70,        // percent
    hue: 0,          // degrees
    c1: "#a855f7",
    c2: "#3b82f6",
    imgOp: 45,       // percent
    blur: 2,         // px
    customImage: ""  // data URL (only persisted when small enough)
  };

  /* ---------------- state ---------------- */
  function loadSettings() {
    var s = {};
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) s = JSON.parse(raw) || {};
    } catch (e) { /* storage unavailable — use defaults */ }
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    for (var k2 in s) {
      if (k2 in out && s[k2] !== undefined && s[k2] !== null) out[k2] = s[k2];
    }
    // sanitize numbers
    out.particles = clamp(Math.round(Number(out.particles) || 0), 0, 220);
    out.speed = clamp(Number(out.speed) || 0, 0, 300);
    out.glow = clamp(Number(out.glow) || 0, 0, 100);
    out.hue = clamp(Number(out.hue) || 0, 0, 360);
    out.imgOp = clamp(Number(out.imgOp) || 0, 0, 100);
    out.blur = clamp(Number(out.blur) || 0, 0, 20);
    if (!PRESETS[out.preset]) out.preset = "nebula";
    return out;
  }

  function saveSettings() {
    try {
      var copy = {};
      for (var k in settings) copy[k] = settings[k];
      // Avoid quota errors: don't persist huge images
      if (typeof copy.customImage === "string" && copy.customImage.length > 900000) {
        copy.customImage = "";
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
    } catch (e) { /* ignore quota / privacy-mode errors */ }
  }

  function clamp(v, min, max) {
    if (isNaN(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  var settings = loadSettings();
  var reducedMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) settings.animated = false;

  /* ---------------- canvas particles ---------------- */
  var canvas = document.getElementById("bg-canvas");
  var ctx = null;
  try { ctx = canvas ? canvas.getContext("2d") : null; } catch (e) { ctx = null; }
  var W = 0, H = 0, DPR = 1;
  var parts = [];
  var rafId = null;
  var lastT = 0;

  function resize() {
    if (!canvas || !ctx) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  function makeParticle() {
    var big = Math.random() < 0.12;
    return {
      x: rand(0, W),
      y: rand(0, H),
      r: big ? rand(2.2, 3.6) : rand(0.8, 2.1),
      vx: rand(-0.25, 0.25),
      vy: rand(-0.35, -0.05),
      tw: rand(0, Math.PI * 2),
      twSpeed: rand(0.5, 2),
      tone: Math.random() // 0 -> accent1, 1 -> accent2/cyan
    };
  }

  function syncParticles() {
    var n = settings.particles;
    while (parts.length < n) parts.push(makeParticle());
    if (parts.length > n) parts.length = n;
  }

  function accent(i) {
    // blend between accent colors by particle tone
    return i < 0.45 ? settings.c1 : (i < 0.8 ? settings.c2 : "#22d3ee");
  }

  function hexToRgb(hex) {
    var h = String(hex || "#a855f7").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return [168, 85, 247];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function draw(now) {
    rafId = null;
    if (!ctx) return;
    var dt = Math.min((now - lastT) / 16.666, 4) || 1;
    lastT = now;
    var speedF = settings.speed / 100;
    var glowA = settings.glow / 100;

    ctx.clearRect(0, 0, W, H);

    var i, p;
    // connections
    if (settings.links && parts.length > 1 && glowA > 0.02) {
      var maxD = 130;
      var c = hexToRgb(settings.c2);
      ctx.lineWidth = 1;
      for (i = 0; i < parts.length; i++) {
        p = parts[i];
        for (var j = i + 1; j < parts.length; j++) {
          var q = parts[j];
          var dx = p.x - q.x, dy = p.y - q.y;
          var d2 = dx * dx + dy * dy;
          if (d2 < maxD * maxD) {
            var a = (1 - Math.sqrt(d2) / maxD) * 0.22 * (0.4 + glowA);
            ctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(3) + ")";
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
      }
    }

    // particles
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      if (settings.animated && speedF > 0) {
        p.x += p.vx * speedF * dt;
        p.y += p.vy * speedF * dt;
        p.tw += 0.03 * p.twSpeed * dt;
        if (p.y < -8) { p.y = H + 8; p.x = rand(0, W); }
        if (p.x < -8) p.x = W + 8;
        if (p.x > W + 8) p.x = -8;
      }
      var alpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(p.tw));
      alpha *= (0.25 + 0.75 * (0.3 + 0.7 * glowA));
      var col = hexToRgb(accent(p.tone));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + alpha.toFixed(3) + ")";
      if (glowA > 0.05) {
        ctx.shadowBlur = 12 * glowA;
        ctx.shadowColor = "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.9)";
      } else {
        ctx.shadowBlur = 0;
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    if (settings.animated) {
      rafId = requestAnimationFrame(draw);
    }
  }

  function startLoop() {
    if (!ctx) return;
    if (rafId) cancelAnimationFrame(rafId);
    lastT = performance.now();
    rafId = requestAnimationFrame(draw);
  }

  function renderOnce() {
    if (!ctx) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    lastT = performance.now();
    // draw a single static frame (temporarily force positions, no motion)
    draw(performance.now() + 16);
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  /* ---------------- apply settings to page ---------------- */
  var root = document.documentElement;
  var orbsEl = document.querySelector(".bg-orbs");
  var gridEl = document.querySelector(".bg-grid");
  var customLayer = document.getElementById("custom-bg-layer");
  var objectUrl = "";

  function applySettings() {
    root.style.setProperty("--accent-1", settings.c1);
    root.style.setProperty("--accent-2", settings.c2);
    var hueVal = "hue-rotate(" + settings.hue + "deg)";
    if (orbsEl) orbsEl.style.filter = settings.hue ? hueVal : "";
    if (canvas) canvas.style.filter = settings.hue ? hueVal : "";

    var orbs = document.querySelectorAll(".orb");
    for (var i = 0; i < orbs.length; i++) {
      orbs[i].style.animationPlayState = settings.animated ? "running" : "paused";
    }
    if (gridEl) gridEl.style.opacity = settings.animated ? "" : "0.35";

    if (customLayer) {
      if (settings.customImage) {
        customLayer.style.backgroundImage = 'url("' + settings.customImage + '")';
        customLayer.style.opacity = String(settings.imgOp / 100);
        customLayer.style.filter = settings.blur > 0
          ? "blur(" + settings.blur + "px)" + (settings.hue ? " " + hueVal : "")
          : (settings.hue ? hueVal : "none");
      } else {
        customLayer.style.backgroundImage = "none";
        customLayer.style.opacity = "0";
      }
    }
    syncParticles();
    if (settings.animated) startLoop();
    else renderOnce();
  }

  /* ---------------- customizer UI ---------------- */
  function $(id) { return document.getElementById(id); }

  function setSwitch(el, on) {
    if (!el) return;
    el.classList.toggle("is-on", !!on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }

  function bindUI() {
    var fab = $("customizer-fab");
    var panel = $("customizer-panel");
    var closeBtn = $("customizer-close");
    if (!fab || !panel) return;

    function open() {
      panel.hidden = false;
      fab.setAttribute("aria-expanded", "true");
    }
    function close() {
      panel.hidden = true;
      fab.setAttribute("aria-expanded", "false");
    }
    fab.addEventListener("click", function () {
      if (panel.hidden) open(); else close();
    });
    if (closeBtn) closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) close();
    });

    // presets
    var presetBtns = panel.querySelectorAll(".preset");
    function markPreset() {
      for (var i = 0; i < presetBtns.length; i++) {
        presetBtns[i].classList.toggle("is-active", presetBtns[i].getAttribute("data-preset") === settings.preset);
      }
    }
    for (var i = 0; i < presetBtns.length; i++) {
      presetBtns[i].addEventListener("click", function () {
        var name = this.getAttribute("data-preset");
        if (!PRESETS[name]) return;
        settings.preset = name;
        settings.c1 = PRESETS[name].c1;
        settings.c2 = PRESETS[name].c2;
        var c1 = $("cust-c1"), c2 = $("cust-c2");
        if (c1) c1.value = settings.c1;
        if (c2) c2.value = settings.c2;
        markPreset();
        applySettings();
        saveSettings();
      });
    }
    markPreset();

    // switches
    var swAnim = $("cust-animate"), swLinks = $("cust-links");
    setSwitch(swAnim, settings.animated);
    setSwitch(swLinks, settings.links);
    if (swAnim) swAnim.addEventListener("click", function () {
      settings.animated = !settings.animated;
      setSwitch(swAnim, settings.animated);
      applySettings(); saveSettings();
    });
    if (swLinks) swLinks.addEventListener("click", function () {
      settings.links = !settings.links;
      setSwitch(swLinks, settings.links);
      applySettings(); saveSettings();
    });

    // sliders
    function bindSlider(id, valId, fmt, apply) {
      var el = $(id), val = $(valId);
      if (!el) return;
      el.addEventListener("input", function () {
        var v = Number(el.value);
        apply(v);
        if (val) val.textContent = fmt(v);
        applySettings(); saveSettings();
      });
      if (val) val.textContent = fmt(Number(el.value));
    }
    var slP = $("cust-particles"), slS = $("cust-speed"), slG = $("cust-glow"),
        slH = $("cust-hue"), slO = $("cust-imgop"), slB = $("cust-blur");
    if (slP) slP.value = settings.particles;
    if (slS) slS.value = settings.speed;
    if (slG) slG.value = settings.glow;
    if (slH) slH.value = settings.hue;
    if (slO) slO.value = settings.imgOp;
    if (slB) slB.value = settings.blur;
    bindSlider("cust-particles", "cust-particles-val", function (v) { return String(v); }, function (v) { settings.particles = clamp(Math.round(v), 0, 220); });
    bindSlider("cust-speed", "cust-speed-val", function (v) { return (v / 100).toFixed(1) + "×"; }, function (v) { settings.speed = clamp(v, 0, 300); });
    bindSlider("cust-glow", "cust-glow-val", function (v) { return v + "%"; }, function (v) { settings.glow = clamp(v, 0, 100); });
    bindSlider("cust-hue", "cust-hue-val", function (v) { return v + "°"; }, function (v) { settings.hue = clamp(v, 0, 360); });
    bindSlider("cust-imgop", "cust-imgop-val", function (v) { return v + "%"; }, function (v) { settings.imgOp = clamp(v, 0, 100); });
    bindSlider("cust-blur", "cust-blur-val", function (v) { return v + "px"; }, function (v) { settings.blur = clamp(v, 0, 20); });

    // custom colors
    var c1 = $("cust-c1"), c2 = $("cust-c2");
    if (c1) {
      c1.value = settings.c1;
      c1.addEventListener("input", function () {
        settings.c1 = c1.value; settings.preset = "custom"; markPreset();
        applySettings(); saveSettings();
      });
    }
    if (c2) {
      c2.value = settings.c2;
      c2.addEventListener("input", function () {
        settings.c2 = c2.value; settings.preset = "custom"; markPreset();
        applySettings(); saveSettings();
      });
    }

    // custom image
    var fileInput = $("cust-file");
    var removeBtn = $("cust-remove");
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (!/^image\//.test(f.type)) {
          toast("Please choose an image file (PNG, JPG, …).", "error");
          fileInput.value = "";
          return;
        }
        if (f.size > 8 * 1024 * 1024) {
          toast("Image is larger than 8 MB — please pick a smaller one.", "error");
          fileInput.value = "";
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (e) {} objectUrl = ""; }
          settings.customImage = String(reader.result || "");
          applySettings(); saveSettings();
          toast("Custom wallpaper applied.", "success");
        };
        reader.onerror = function () {
          toast("Could not read that image. Please try another file.", "error");
        };
        reader.readAsDataURL(f);
        fileInput.value = "";
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener("click", function () {
        settings.customImage = "";
        applySettings(); saveSettings();
        toast("Custom wallpaper removed.");
      });
    }

    // reset
    var resetBtn = $("cust-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        settings = {};
        for (var k in DEFAULTS) settings[k] = DEFAULTS[k];
        if (reducedMotion) settings.animated = false;
        // refresh controls
        markPreset();
        setSwitch(swAnim, settings.animated);
        setSwitch(swLinks, settings.links);
        if (slP) { slP.value = settings.particles; $("cust-particles-val").textContent = settings.particles; }
        if (slS) { slS.value = settings.speed; $("cust-speed-val").textContent = "1.0×"; }
        if (slG) { slG.value = settings.glow; $("cust-glow-val").textContent = settings.glow + "%"; }
        if (slH) { slH.value = settings.hue; $("cust-hue-val").textContent = "0°"; }
        if (slO) { slO.value = settings.imgOp; $("cust-imgop-val").textContent = settings.imgOp + "%"; }
        if (slB) { slB.value = settings.blur; $("cust-blur-val").textContent = settings.blur + "px"; }
        if (c1) c1.value = settings.c1;
        if (c2) c2.value = settings.c2;
        applySettings(); saveSettings();
        toast("Background reset to defaults.", "success");
      });
    }
  }

  /* toast helper (shared — also used by app.js if present) */
  function toast(msg, type) {
    if (window.VocalPure && typeof window.VocalPure.toast === "function") {
      window.VocalPure.toast(msg, type);
      return;
    }
    var wrap = document.getElementById("toast-wrap");
    if (!wrap) return;
    var el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      el.style.transition = "opacity .4s";
      setTimeout(function () { el.remove(); }, 450);
    }, 2800);
  }

  /* ---------------- init ---------------- */
  var initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    resize();
    bindUI();
    applySettings();
    window.addEventListener("resize", function () {
      resize();
      if (!settings.animated) renderOnce();
    });
    document.addEventListener("visibilitychange", function () {
      if (!ctx) return;
      if (document.hidden) {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      } else if (settings.animated && !rafId) {
        startLoop();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
