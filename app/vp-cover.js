/* ============================================================================
   VocalPure — embedded cover art extractor  ·  app/vp-cover.js
   ----------------------------------------------------------------------------
   Reads the artwork that lives INSIDE the audio file itself (no sidecar
   .jpg hunting, no network) and hands the app a display-ready data URL:

     · MP3 / MP2   — ID3v2.2, v2.3 and v2.4 APIC frames: all four text
                     encodings (latin-1, UTF-16±BOM, UTF-8), syncsafe v2.4
                     sizes, null-terminated MIME, extended headers,
                     corrupt-frame resync
     · FLAC        — PICTURE metadata block (type 6)
     · M4A / MP4   — moov/udta/meta/ilst/covr/data box walk. Works when the
                     moov atom sits at the front of the file OR at the end
                     (the parser scans, it never assumes an offset)
     · OGG Vorbis  — METADATA_BLOCK_PICTURE (base64 FLAC picture block)

   Every parser is a pure function on a Uint8Array, so the exact same code
   runs in the Android WebView, in a desktop browser and in the Node
   test-suite. Nothing ever throws: unknown containers, truncated tags or
   corrupt frames simply yield null and the app shows its default artwork.
   ========================================================================== */
(function (root) {
  "use strict";

  /* ---------------- base64 (no btoa/atob dependency) ---------------- */
  var B64CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function b64encode(bytes) {
    var s = "", i = 0, n = bytes.length, v;
    for (; i + 2 < n; i += 3) {
      v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64CH[v >> 18 & 63] + B64CH[v >> 12 & 63] + B64CH[v >> 6 & 63] + B64CH[v & 63];
    }
    var rem = n - i;
    if (rem === 1) {
      v = bytes[i] << 16;
      s += B64CH[v >> 18 & 63] + B64CH[v >> 12 & 63] + "==";
    } else if (rem === 2) {
      v = (bytes[i] << 16) | (bytes[i + 1] << 8);
      s += B64CH[v >> 18 & 63] + B64CH[v >> 12 & 63] + B64CH[v >> 6 & 63] + "=";
    }
    return s;
  }
  function b64decode(str) {
    str = String(str).replace(/[^A-Za-z0-9+/=]/g, "");
    var out = [], i = 0, n = str.length;
    while (i < n) {
      var c1 = B64CH.indexOf(str.charAt(i));
      var c2 = B64CH.indexOf(str.charAt(i + 1));
      if (c1 < 0 || c2 < 0) break;
      var c3 = str.charAt(i + 2);
      var c4 = str.charAt(i + 3);
      var c3v = (c3 === "=" || c3 === "") ? -1 : B64CH.indexOf(c3);
      var c4v = (c4 === "=" || c4 === "") ? -1 : B64CH.indexOf(c4);
      out.push((c1 << 2) | (c2 >> 4));
      if (c3v >= 0) {
        out.push((c2 & 15) << 4 | (c3v >> 2));
        if (c4v >= 0) out.push((c3v & 3) << 6 | c4v);
        i += 4;
      } else {
        i += 3;
      }
    }
    return new Uint8Array(out);
  }

  /* ---------------- text helpers (ID3 encodings) ---------------- */
  /* Position just past the null terminator of a C-string in the given
     encoding (for UTF-16 the terminator is a 0x00 0x00 pair). */
  function cstrEnd(buf, start, end, enc) {
    var o = start;
    if (enc === 1 || enc === 2) {
      if (enc === 1 && end - start >= 2) o = start + 2;   /* skip the BOM */
      for (; o + 1 < end; o += 2) {
        if (buf[o] === 0 && buf[o + 1] === 0) return o;
      }
      return end;
    }
    for (var i = start; i < end; i++) if (buf[i] === 0) return i;
    return end;
  }
  function cstrStep(enc) { return (enc === 1 || enc === 2) ? 2 : 1; }
  function readText(buf, start, end, enc) {
    if (start >= end) return "";
    var i, s, o;
    if (enc === 0) {
      s = "";
      for (i = start; i < end; i++) s += String.fromCharCode(buf[i]);
      return s;
    }
    if (enc === 1 || enc === 2) {
      o = start;
      var be = (enc === 2);
      if (enc === 1 && end - start >= 2) {
        if (buf[start] === 0xFF && buf[start + 1] === 0xFE) { o = start + 2; be = false; }
        else if (buf[start] === 0xFE && buf[start + 1] === 0xFF) { o = start + 2; be = true; }
      }
      s = "";
      for (; o + 1 < end; o += 2) {
        var cp = be ? (buf[o] << 8) | buf[o + 1] : (buf[o + 1] << 8) | buf[o];
        if (cp === 0) break;
        s += String.fromCharCode(cp);
      }
      return s;
    }
    try {
      if (typeof TextDecoder !== "undefined") {
        return new TextDecoder("utf-8").decode(buf.subarray(start, end));
      }
    } catch (e) { /* fall back to byte-wise */ }
    s = "";
    for (i = start; i < end; i++) s += String.fromCharCode(buf[i]);
    return s;
  }

  /* ---------------- image magic sniffing ---------------- */
  function guessMime(b) {
    if (!b || b.length < 4) return "image/jpeg";
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "image/jpeg";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "image/png";
    if (b[0] === 0x47 && b[1] === 0x49 && b.length > 2 && b[2] === 0x89) return "image/gif";
    if (b.length >= 12 && b[8] === 0x42 && b[9] === 0x4D) return "image/bmp";
    return "image/jpeg";
  }

  /* ---------------- ID3v2 (2.2 / 2.3 / 2.4) ---------------- */
  function isAlphaNum(c) {
    return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
  }
  function id3Id(buf, pos, len) {
    if (pos + len > buf.length) return null;
    var s = "";
    for (var i = 0; i < len; i++) {
      var c = buf[pos + i];
      if (!isAlphaNum(c)) return null;
      s += String.fromCharCode(c);
    }
    return s;
  }
  function parseID3(buf) {
    var n = buf.length;
    if (n < 10) return null;
    if (!(buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)) return null; /* ID3 */
    var ver = buf[3];
    if (ver < 2 || ver > 4) return null;
    var flags = buf[5];
    var size = (ver === 4)
      ? ((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) | ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F)
      : ((buf[6] << 24) >>> 0) | (buf[7] << 16) | (buf[8] << 8) | buf[9];
    if (!isFinite(size) || size < 0 || size > n) return null;
    var end = Math.min(n, 10 + size);
    var pos = 10;
    if (flags & 0x40) {                                   /* extended header */
      var ext = (ver === 4)
        ? (((buf[10] & 0x7F) << 21) | ((buf[11] & 0x7F) << 14) | ((buf[12] & 0x7F) << 7) | (buf[13] & 0x7F)) - 4 + 4
        : ver === 3 ? ((buf[10] << 24) >>> 0) | (buf[11] << 16) | (buf[12] << 8) | buf[13]
        : (buf[10] << 16) | (buf[11] << 8) | buf[12];
      if (ext > 4 && ext < end - pos) pos += ext;
    }
    while (pos < end) {
      var frameId, frameStart, frameEnd, frameFlags = 0;
      if (ver === 2) {
        frameId = id3Id(buf, pos, 3);
        if (!frameId) break;
        var sz2 = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
        if (sz2 === 0 || pos + 6 + sz2 > end + 4) break;
        frameStart = pos + 6;
        frameEnd = pos + 6 + sz2;
        pos = frameEnd;
      } else {
        frameId = id3Id(buf, pos, 4);
        if (!frameId) break;
        var sz = (ver === 4)
          ? ((buf[pos + 4] & 0x7F) << 21) | ((buf[pos + 5] & 0x7F) << 14) | ((buf[pos + 6] & 0x7F) << 7) | (buf[pos + 7] & 0x7F)
          : ((buf[pos + 4] << 24) >>> 0) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7];
        frameFlags = buf[pos + 8];
        if (sz === 0 || sz > end - pos - 10) {
          /* corrupt size — resync on the next plausible frame header,
             scanning at most the next 512 KB (or the tag end) */
          var q = pos + 4;
          var qEnd = Math.min(end - 10, pos + 512 * 1024);
          var found = false;
          for (; q < qEnd; q++) {
            if (id3Id(buf, q, 4)) { pos = q; found = true; break; }
          }
          if (!found) break;
          continue;
        }
        frameStart = pos + 10;
        frameEnd = pos + 10 + sz;
        pos = frameEnd;
      }
      var isPic = (ver === 2) ? (frameId === "PIC") : (frameId === "APIC");
      if (isPic && !(frameFlags & 0x10)) { /* encrypted frames are useless */
        var img = parseApic(buf, frameStart, frameEnd, ver);
        if (img) return img;
      }
    }
    return null;
  }
  function parseApic(buf, s, e, ver) {
    if (e - s < 4) return null;
    var p = s;
    var enc = buf[p++];
    if (enc > 3) return null;
    var data, mime;
    if (ver === 2) {
      /* v2.2 has no MIME field: encoding, description, then the image */
      var dEnd = cstrEnd(buf, p, e, enc);
      data = buf.subarray(dEnd + cstrStep(enc), e);
      if (data.length < 8) return null;
      return { mime: guessMime(data), data: data.slice() };
    }
    /* The MIME field is ISO-8859-1 regardless of the frame's text
       encoding (per the ID3v2.3 / v2.4 APIC layout). */
    var mEnd = cstrEnd(buf, p, e, 0);
    if (mEnd >= e) return null;
    mime = readText(buf, p, mEnd, 0).trim();
    p = mEnd + 1;
    if (p + 2 > e) return null;
    p += 1; /* picture type */
    var dEnd2 = cstrEnd(buf, p, e, enc);
    p = dEnd2 + cstrStep(enc);
    data = buf.subarray(p, e);
    if (data.length < 8) return null;
    if (!mime) mime = guessMime(data);
    if (mime.indexOf("image/") !== 0) mime = "image/jpeg";
    return { mime: mime, data: data.slice() };
  }

  /* ---------------- FLAC ---------------- */
  function isFlacMagic(b) {
    if (b.length < 4) return false;
    if (b[1] !== 0x4C || b[2] !== 0x61 || b[3] !== 0x43) return false; /* LaC */
    return b[0] === 0x66 || b[0] === 0x46;                             /* f|F */
  }
  function parseFlac(buf) {
    if (!isFlacMagic(buf)) return null;
    var pos = 4;
    while (pos + 4 <= buf.length) {
      var h = buf[pos];
      var last = (h & 0x80) !== 0;
      var type = h & 0x7F;
      var len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
      var s = pos + 4, e = s + len;
      if (e > buf.length) break;
      if (type === 6) {
        var img = parseFlacPicture(buf, s, e);
        if (img) return img;
      }
      if (last || len === 0) break;
      pos = e;
    }
    return null;
  }
  function parseFlacPicture(buf, s, e) {
    if (e - s < 32) return null;
    var p = s;
    function u32() {
      var v = ((buf[p] << 24) >>> 0) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
      p += 4;
      return v;
    }
    u32(); /* picture type */
    var mimeLen = u32();
    if (p + mimeLen > e || mimeLen > 64) return null;
    var mime = "";
    for (var i = 0; i < mimeLen; i++) mime += String.fromCharCode(buf[p + i]);
    mime = mime.replace(/\0+$/g, "").trim();   /* tolerate NUL padding */
    p += mimeLen;
    var descLen = u32();
    if (p + descLen > e) return null;
    p += descLen;
    p += 16; /* width, height, depth, colours */
    if (p >= e) return null;
    var data = buf.subarray(p, e);
    if (data.length < 8) return null;
    if (!mime) mime = guessMime(data);
    if (mime.indexOf("image/") !== 0) mime = "image/jpeg";
    return { mime: mime, data: data.slice() };
  }

  /* ---------------- MP4 / M4A ---------------- */
  function boxChild(buf, s, e, name) {
    var p = s;
    while (p + 8 <= e) {
      var size = ((buf[p] << 24) >>> 0) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
      var id = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      var next;
      if (size === 1) next = e;                    /* 64-bit size — treat as rest */
      else if (size === 0) next = e;               /* size fills the parent */
      else next = p + size;
      if (next < p + 8) next = p + 8;
      if (next > e) next = e;
      if (id === name) return { p: p, s: p + 8, e: next };
      p = next;
    }
    return null;
  }
  function findCovr(buf, ms, me) {
    var udta = boxChild(buf, ms, me, "udta");
    if (!udta) return null;
    var meta = boxChild(buf, udta.s, udta.e, "meta");
    if (!meta) return null;
    var body = meta.s;
    /* "meta" carries 4 version/flags bytes before its children */
    if (me - meta.s >= 4 && buf[meta.p + 4] === 0x6D) body = meta.s + 4;
    var ilst = boxChild(buf, body, meta.e, "ilst");
    if (!ilst) return null;
    var covr = boxChild(buf, ilst.s, ilst.e, "covr");
    if (!covr) return null;
    var data = boxChild(buf, covr.s, covr.e, "data");
    if (!data) return null;
    var p = data.s;
    if (data.e - p < 13) return null;
    /* data atom: type indicator (4) + locale (1) + declared length (4) */
    var type = ((buf[p] << 24) >>> 0) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    p += 9;
    var bytes = buf.subarray(p, data.e);
    if (bytes.length < 8) return null;
    var mime = type === 14 ? "image/png" : (type === 13 ? "image/jpeg" : guessMime(bytes));
    return { mime: mime, data: bytes.slice() };
  }
  function parseMp4(buf) {
    var n = buf.length;
    for (var i = 8; i + 4 <= n; i += 4) {
      if (buf[i] === 0x6D && buf[i + 1] === 0x6F && buf[i + 2] === 0x6F && buf[i + 3] === 0x76) { /* moov */
        var size = ((buf[i - 4] << 24) >>> 0) | (buf[i - 3] << 16) | (buf[i - 2] << 8) | buf[i - 1];
        if (size >= 8 && i - 4 + size <= n) {
          /* scan the moov PAYLOAD (after its 8-byte header), not the box */
          var img = findCovr(buf, i + 4, i - 4 + size);
          if (img) return img;
        }
      }
    }
    return null;
  }

  /* ---------------- OGG Vorbis ---------------- */
  function parseOgg(buf) {
    var key = "METADATA_BLOCK_PICTURE=";
    var kb = new Array(key.length), q;
    for (q = 0; q < key.length; q++) kb[q] = key.charCodeAt(q);
    for (var p = 0; p + key.length + 16 <= buf.length; p++) {
      var ok = true;
      for (q = 0; q < key.length; q++) {
        if (buf[p + q] !== kb[q]) { ok = false; break; }
      }
      if (!ok) continue;
      var s = p + key.length, e = s;
      while (e < buf.length && buf[e] !== 0) e++;
      if (e - s < 16) continue;
      var b64 = "";
      for (var r = s; r < e; r++) b64 += String.fromCharCode(buf[r]);
      try {
        var pic = b64decode(b64);
        if (pic.length < 16) continue;
        return parseFlac(pic); /* a FLAC PICTURE metadata block */
      } catch (err) { continue; }
    }
    return null;
  }

  /* ---------------- top level ---------------- */
  function findCoverImage(bytes) {
    if (!bytes || bytes.length < 16) return null;
    var b = bytes;
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return parseID3(b);
    if (isFlacMagic(b)) return parseFlac(b);
    if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return parseOgg(b); /* OggS */
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      return parseMp4(b); /* ftyp */
    }
    return null;
  }

  /* ---------------- display normalisation (DOM only) ---------------- */
  function bytesToDataUrl(bytes, mime) {
    return "data:" + (mime || "image/jpeg") + ";base64," + b64encode(bytes);
  }
  function hasImageCanvas() {
    try {
      if (typeof document === "undefined" || typeof Image === "undefined") return false;
      var cv = document.createElement("canvas");
      var ctx = cv.getContext ? cv.getContext("2d") : null;
      return !!(ctx && typeof ctx.drawImage === "function" && typeof ctx.toDataURL === "function");
    } catch (e) { return false; }
  }
  function loadImage(src, timeout) {
    return new Promise(function (resolve) {
      if (typeof Image === "undefined") { resolve(null); return; }
      var img = new Image();
      var done = false;
      var to = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeout || 2000);
      img.onload = function () { if (!done) { done = true; clearTimeout(to); resolve(img); } };
      img.onerror = function () { if (!done) { done = true; clearTimeout(to); resolve(null); } };
      img.src = src;
    });
  }
  /* Cover-crop downscale to a 512 px max edge + JPEG re-encode, so a huge
     embedded art never clobbers memory or IndexedDB. Falls back to the raw
     data URL when the environment cannot rasterise (and never rejects). */
  function normalizeCover(bytes, mime) {
    var MAX = 512;
    var rawUrl = bytesToDataUrl(bytes, mime);
    if (!hasImageCanvas()) return Promise.resolve(rawUrl);
    return loadImage(rawUrl, 2500).then(function (img) {
      if (!img || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return rawUrl;
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, MAX / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var cv = document.createElement("canvas");
      cv.width = cw;
      cv.height = ch;
      var ctx = cv.getContext("2d");
      if (!ctx) return rawUrl;
      ctx.imageSmoothingEnabled = true;
      try { ctx.imageSmoothingQuality = "high"; } catch (e) { /* older engines */ }
      ctx.fillStyle = "#0b111b";
      ctx.fillRect(0, 0, cw, ch);
      try {
        ctx.drawImage(img, 0, 0, w, h, 0, 0, cw, ch);
      } catch (e) { return rawUrl; }
      var url = null;
      try { url = cv.toDataURL("image/jpeg", 0.85); } catch (e) { url = null; }
      if (!url) return rawUrl;
      return url.length < rawUrl.length ? url : rawUrl;
    });
  }

  /* Beautiful default artwork (used when the file carries no embedded art):
     the app identity — night gradient, neon ring, music note, gold accent. */
  var DEFAULT_COVER = (function () {
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'>" +
      "<defs>" +
      "<linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='#2fe6c8'/><stop offset='1' stop-color='#3aa6ff'/>" +
      "</linearGradient>" +
      "<radialGradient id='r' cx='0.5' cy='0.32' r='0.95'>" +
      "<stop offset='0' stop-color='#17293d'/>" +
      "<stop offset='0.55' stop-color='#0b1420'/>" +
      "<stop offset='1' stop-color='#070b12'/>" +
      "</radialGradient>" +
      "</defs>" +
      "<rect width='512' height='512' fill='url(#r)'/>" +
      "<circle cx='256' cy='256' r='172' fill='none' stroke='url(#g)' stroke-opacity='0.15' stroke-width='44'/>" +
      "<circle cx='256' cy='256' r='128' fill='none' stroke='url(#g)' stroke-width='14'/>" +
      "<g fill='url(#g)'>" +
      "<ellipse cx='221' cy='332' rx='47' ry='37' transform='rotate(-18 221 332)'/>" +
      "<rect x='253' y='146' width='18' height='190' rx='9'/>" +
      "<path d='M271 146c64 20 82 64 60 126 28-44 20-94-20-122-14-10-30-13-40-4z'/>" +
      "</g>" +
      "<circle cx='386' cy='370' r='15' fill='#f2c14e'/>" +
      "</svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  })();

  root.VP = {
    findCoverImage: findCoverImage,
    parseID3: parseID3,
    parseFlac: parseFlac,
    parseMp4: parseMp4,
    parseOgg: parseOgg,
    b64encode: b64encode,
    b64decode: b64decode,
    bytesToDataUrl: bytesToDataUrl,
    normalizeCover: normalizeCover,
    guessMime: guessMime,
    DEFAULT_COVER: DEFAULT_COVER
  };
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
