/* ============================================================
   VocalPure — download-site logic
   Nav, reveal-on-scroll, download center, QR, checksums.
   The player lives ONLY in the Android app (app/ directory) —
   this site is purely the download interface.
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
      toast("These pages are not live yet — the app itself is what matters.");
    });
  });

  /* ---------------- app info + downloads ---------------- */
  var FALLBACK_INFO = {
    version: "v2.7.0",
    versionPlain: "2.7.0",
    betaVersion: "v2.8.0-beta.1",
    size: "—",
    betaSize: "—",
    updated: "Sep 18, 2026",
    minAndroid: "8.0+",
    sha256: "…",
    stableFile: "downloads/VocalPure-v2.7.0.apk",
    betaFile: "downloads/VocalPure-v2.8.0-beta.1.apk"
  };

  function fillAppInfo(info) {
    var map = {
      version: info.version, versionPlain: info.versionPlain,
      betaVersion: info.betaVersion,
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
})();
