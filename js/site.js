/* ============================================================
   VocalPure website — download-interface logic.
   ------------------------------------------------------------
   The site is a pure download center: navigation, reveal
   animations, release metadata (app-info.json), download card,
   QR code and toasts. The music player itself lives only in
   the Android app (app/ in the repo) — nothing here plays or
   processes audio.
   ============================================================ */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  /* ---------------- toasts ---------------- */
  var toastWrap = $("toast-wrap");
  function toast(msg, type) {
    if (!toastWrap) return;
    var t = document.createElement("div");
    t.className = "toast" + (type ? " " + type : "");
    t.textContent = msg;
    toastWrap.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .4s, transform .4s";
      t.style.opacity = "0";
      t.style.transform = "translateY(8px)";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 450);
    }, 2800);
  }

  /* ---------------- header / nav ---------------- */
  var header = $("site-header");
  function updateHeader() {
    if (header) header.classList.toggle("scrolled", window.scrollY > 24);
  }
  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });

  var navToggle = $("nav-toggle");
  var mainNav = $("main-nav");
  on(navToggle, "click", function () {
    var open = mainNav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  on(mainNav, "click", function (e) {
    if (e.target.tagName === "A") {
      mainNav.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      mainNav.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
    }
  });

  /* ---------------- reveal on scroll ---------------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.14 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------------- year ---------------- */
  var year = $("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------------- legal placeholders ---------------- */
  ["link-privacy", "link-terms", "link-contact"].forEach(function (id) {
    on($(id), "click", function (e) {
      e.preventDefault();
      var msg = {
        "link-privacy": "Privacy: VocalPure processes nothing in the cloud — your songs stay on your phone. A full policy ships with the app.",
        "link-terms": "Terms: free for personal use. Only separate vocals from music you own or have the right to remix.",
        "link-contact": "Contact: hello@vocalpure.app — we read everything."
      }[id];
      toast(msg);
    });
  });

  /* ---------------- release info + download center ---------------- */
  var FALLBACK_INFO = {
    version: "v3.0.0",
    versionPlain: "3.0.0",
    size: "—",
    updated: "Sep 18, 2026",
    minAndroid: "8.0+",
    sha256: "…",
    file: "downloads/VocalPure-v3.0.0.apk"
  };

  function fillAppInfo(info) {
    var map = {
      version: info.version, versionPlain: info.versionPlain,
      size: info.size, updated: info.updated,
      minAndroid: info.minAndroid, sha256: info.sha256
    };
    var els = document.querySelectorAll("[data-app]");
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute("data-app");
      if (map[key] !== undefined && map[key] !== null) els[i].textContent = map[key];
    }
    var hv = $("hero-version");
    if (hv && info.version) hv.textContent = info.version + " · Android " + (info.minAndroid || "8.0+") + " · 100% Free";
    var dl = $("dl-stable");
    if (dl && info.file) dl.setAttribute("href", info.file);
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
    setupQr(info.file || FALLBACK_INFO.file);
  }

  function setupQr(file) {
    var img = $("dl-qr-img");
    if (!img) return;
    var url = file;
    try { url = new URL(file, window.location.href).href; } catch (e) { /* keep relative */ }
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

  on($("dl-copy"), "click", function () {
    var href = ($("dl-stable") && $("dl-stable").getAttribute("href")) || FALLBACK_INFO.file;
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
})();
