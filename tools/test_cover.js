#!/usr/bin/env node
"use strict";
/* ============================================================================
   VocalPure — cover-art extractor test-suite  ·  tools/test_cover.js
   ----------------------------------------------------------------------------
   Builds tiny SYNTHETIC audio files (no recordings, no network) that carry
   real embedded artwork in each supported container, then verifies the
   production parser (app/vp-cover.js) finds the exact same bytes back:

     · ID3v2.3 MP3  — APIC frame, latin-1 MIME + description
     · ID3v2.4 MP3  — syncsafe frame size, UTF-8 description
     · ID3v2.2 MP3  — legacy 3-char PIC frame (no MIME field)
     · ID3v2 UTF-16 — BOM-prefixed description (encoding 1)
     · FLAC         — PICTURE metadata block (type 6)
     · M4A / MP4    — covr atom with moov at the FRONT of the file
     · M4A / MP4    — covr atom with moov at the END of the file
     · OGG Vorbis   — METADATA_BLOCK_PICTURE (base64 FLAC picture block)
     · no artwork   — plain file must yield null, never throw
     · base64       — encode/decode round-trip
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app", "vp-cover.js"), "utf8");

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
}

/* Load the production module in a clean VM (browser-global fallback). */
const sandbox = { globalThis: {}, console, TextEncoder, TextDecoder,
                  Uint8Array, ArrayBuffer, Promise, setTimeout, clearTimeout,
                  Image: undefined, document: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: "vp-cover.js" });
const VP = sandbox.globalThis.VP;
check("module exposes its API", !!VP && typeof VP.findCoverImage === "function" &&
  typeof VP.parseID3 === "function" && typeof VP.parseFlac === "function" &&
  typeof VP.parseMp4 === "function" && typeof VP.parseOgg === "function" &&
  typeof VP.b64encode === "function" && typeof VP.b64decode === "function");
check("default artwork is a valid data URI",
  typeof VP.DEFAULT_COVER === "string" && VP.DEFAULT_COVER.startsWith("data:image/svg+xml") &&
  VP.DEFAULT_COVER.length > 300, VP.DEFAULT_COVER ? VP.DEFAULT_COVER.length + " chars" : "missing");

/* ------------------------------------------------------------- builders */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xFC, 0xCF, 0xC0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
]);
const JUNK = new Uint8Array(256).map((_, i) => (i * 7) & 0xFF);

function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u32be(v) { return new Uint8Array([(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]); }
function u32le(v) { return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]); }
function str(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
function cstr(s) { return concat(str(s), new Uint8Array([0])); }
function syncsafe(v) {
  return new Uint8Array([(v >> 21) & 0x7F, (v >> 14) & 0x7F, (v >> 7) & 0x7F, v & 0x7F]);
}

function b64enc(bytes) { return VP.b64encode(bytes); }

/* ---------------- MP3 builders ---------------- */
function id3v2apic(enc, mime, desc, img, ver) {
  /* APIC payload */
  const encB = new Uint8Array([enc]);
  let payload;
  if (ver === 2) {
    payload = concat(encB, cstr16(desc, enc), img);          /* PIC: no mime */
  } else {
    payload = concat(encB, cstr(mime), new Uint8Array([3]), cstr16(desc, enc), img);
  }
  const id = str(ver === 2 ? "PIC" : "APIC");
  const size = ver === 4 ? syncsafe(payload.length)
    : ver === 3 ? u32be(payload.length)
    : u32be(payload.length).subarray(1);                      /* v2.2: 3 bytes */
  const flags = ver === 2 ? new Uint8Array(0) : new Uint8Array([0, 0]);
  return concat(id, size, flags, payload);
}
function cstr16(s, enc) {
  if (enc === 0 || enc === 3) return cstr(s);
  const body = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (enc === 1) { body[i * 2] = c & 0xFF; body[i * 2 + 1] = (c >> 8) & 0xFF; }
    else { body[i * 2] = (c >> 8) & 0xFF; body[i * 2 + 1] = c & 0xFF; }
  }
  const bom = enc === 1 ? new Uint8Array([0xFF, 0xFE]) : new Uint8Array(0);
  return concat(bom, body, new Uint8Array(2));                /* 16-bit NUL */
}
function id3v2(ver, frames) {
  const body = concat(...frames);
  const size = ver === 4 ? syncsafe(body.length) : u32be(body.length);
  /* header: "ID3" + major + revision + flags + size (10 bytes total) */
  const head = concat(str("ID3"), new Uint8Array([ver, 0, 0]), size);
  return concat(head, body);
}
function mp3(tag) { return concat(tag, JUNK.subarray(0, 128), new Uint8Array([0xFF, 0xFB, 0x90, 0x00])); }

/* ---------------- FLAC builder ----------------
   (FLAC PICTURE strings are length-prefixed, NOT null-terminated) */
function flac(img) {
  const mime = str("image/png");
  const desc = str("Cover art");
  const meta = concat(
    u32be(3), u32be(mime.length), mime, u32be(desc.length), desc,
    u32be(1), u32be(1), u32be(8), u32be(1), img
  );
  const header = new Uint8Array([0x86, (meta.length >> 16) & 0x7F, (meta.length >> 8) & 0xFF, meta.length & 0xFF]);
  const streaminfo = new Uint8Array(34);                       /* dummy, type 0 */
  const siHeader = new Uint8Array([0x00, 0x00, 0x00, 0x22]);   /* type 0, not last */
  return concat(str("fLaC"), siHeader, streaminfo, header, meta);
}

/* ---------------- MP4 builder ---------------- */
function box(type, ...children) {
  const body = concat(...children);
  return concat(u32be(8 + body.length), str(type), body);
}
function mp4File(moovFirst) {
  const ftyp = box("ftyp", str("M4A "), u32be(0), str("M4A mp42isom"));
  const free = box("free", new Uint8Array(64));
  /* data atom payload: type indicator (1 = PNG) + locale (0) + length + image */
  const data = box("data", new Uint8Array([0, 0, 0, 1, 0]), u32be(PNG_1x1.length), PNG_1x1);
  const covr = box("covr", data);
  const ilst = box("ilst", covr);
  const meta = box("meta", new Uint8Array([0, 0, 0, 0]), ilst);
  const udta = box("udta", meta);
  const moov = box("moov", udta);
  const mdat = box("mdat", new Uint8Array(128).map((_, i) => i & 0xFF));
  return moovFirst ? concat(ftyp, moov, mdat, free) : concat(ftyp, mdat, free, moov);
}

/* ---------------- OGG builder ---------------- */
function ogg(img) {
  /* METADATA_BLOCK_PICTURE value = a FLAC PICTURE metadata block:
     "fLaC" magic + block header (type 6) + picture body */
  const descB = str("cover");
  const body = concat(u32be(3), u32be(9), str("image/png"), u32be(descB.length), descB,
    u32be(1), u32be(1), u32be(8), u32be(1), img);
  const h = new Uint8Array([0x86, (body.length >> 16) & 0x7F, (body.length >> 8) & 0xFF, body.length & 0xFF]);
  const picBlock = concat(str("fLaC"), h, body);
  const field = cstr("METADATA_BLOCK_PICTURE=" + b64enc(picBlock));
  const vendor = cstr("VocalPure-test/1.0 (synthetic)");
  const comment = concat(u32le(vendor.length), vendor, u32le(1), u32le(field.length), field);
  const packet = concat(str("\x01vorbis"), comment);
  const page = concat(str("OggS"), new Uint8Array([0, 0]),
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    new Uint8Array([packet.length & 0xFF]), new Uint8Array([packet.length & 0xFF]), packet);
  return page;
}

/* ------------------------------------------------------------- helpers */
function expectImage(name, bytes, wantMime) {
  let img = null, err = null;
  try { img = VP.findCoverImage(bytes); } catch (e) { err = e; }
  if (err) { check(name, false, "threw: " + err.message); return; }
  const okMime = !wantMime || img.mime === wantMime;
  const okBytes = img && img.data instanceof Uint8Array &&
    img.data.length === PNG_1x1.length &&
    img.data.every((v, i) => v === PNG_1x1[i]);
  check(name, !!img && okMime && okBytes,
    img ? `mime=${img.mime} bytes=${img.data.length}` : "no image found");
}

/* ------------------------------------------------------------- the tests */
console.log("VocalPure cover extractor — container tests\n");

expectImage("ID3v2.3 MP3 with APIC (latin-1)",
  mp3(id3v2(3, [id3v2apic(0, "image/png", "Front cover", PNG_1x1, 3)])), "image/png");

expectImage("ID3v2.4 MP3 with APIC (syncsafe size, UTF-8 desc)",
  mp3(id3v2(4, [id3v2apic(3, "image/png", "Front cover", PNG_1x1, 4)])), "image/png");

expectImage("ID3v2.2 MP3 with legacy PIC frame (no MIME field)",
  mp3(id3v2(2, [id3v2apic(0, "", "Front cover", PNG_1x1, 2)])), "image/png");

expectImage("ID3v2.3 MP3 with APIC (UTF-16LE BOM description)",
  mp3(id3v2(3, [id3v2apic(1, "image/png", "Front cover", PNG_1x1, 3)])), "image/png");

expectImage("ID3v2.3 MP3 with text frames before APIC (skip TIT2/TPE1)",
  mp3(id3v2(3, [
    concat(str("TIT2"), u32be(5), new Uint8Array([0, 0]), cstr("Song")),
    concat(str("TPE1"), u32be(5), new Uint8Array([0, 0]), cstr("Band")),
    id3v2apic(0, "image/png", "art", PNG_1x1, 3)
  ])), "image/png");

expectImage("FLAC with PICTURE block", flac(PNG_1x1), "image/png");

expectImage("M4A with moov at the FRONT", mp4File(true), "image/png");
expectImage("M4A with moov at the END", mp4File(false), "image/png");

expectImage("OGG Vorbis with METADATA_BLOCK_PICTURE", ogg(PNG_1x1), "image/png");

{
  let threw = false;
  try {
    const r = VP.findCoverImage(concat(str("RIFF"), new Uint8Array(256)));
    check("unknown container returns null (no throw)", r === null, String(r));
  } catch (e) { threw = true; }
  check("unknown container returns null (no throw)", !threw, threw ? "threw" : "");
}

{
  let threw = false;
  try {
    const r = VP.findCoverImage(new Uint8Array([1, 2, 3]));
    check("truncated input returns null (no throw)", r === null, String(r));
  } catch (e) { threw = true; }
  check("truncated input returns null (no throw)", !threw, threw ? "threw" : "");
}

{
  /* corrupt ID3 size must not hang or crash — resync path */
  const bad = concat(str("ID3"), new Uint8Array([3, 0]), u32be(0xFFFF),
    str("APIC"), u32be(5000), new Uint8Array(64));
  let threw = false, r = "x";
  const t0 = Date.now();
  try { r = VP.findCoverImage(bad); } catch (e) { threw = true; }
  check("corrupt ID3 frame sizes are tolerated (no hang, no throw)",
    !threw && Date.now() - t0 < 2000, threw ? "threw" : `${Date.now() - t0} ms, result ${r === null ? "null" : "image"}`);
}

{
  const rnd = new Uint8Array(3000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 31 + 7) & 0xFF;
  const enc = VP.b64encode(rnd);
  const dec = VP.b64decode(enc);
  let same = dec.length === rnd.length;
  if (same) for (let i = 0; i < rnd.length; i++) if (dec[i] !== rnd[i]) { same = false; break; }
  check("base64 round-trip (3000 random bytes, all 4 mod-3 remainders)", same,
    `enc ${enc.length} chars, dec ${dec.length} bytes`);
  const e1 = VP.b64encode(new Uint8Array([0x01]));
  const e2 = VP.b64encode(new Uint8Array([0x01, 0x02]));
  check("base64 padding forms", e1 === "AQ==" && e2 === "AQI=", e1 + " / " + e2);
  const d1 = VP.b64decode("AQ==");
  const d2 = VP.b64decode("AQI=");
  check("base64 decode padding forms", d1.length === 1 && d1[0] === 1 && d2.length === 2 && d2[0] === 1 && d2[1] === 2,
    JSON.stringify([d1, d2]));
}

console.log("");
console.log(failed ? `${failed} cover check(s) FAILED` : "all cover checks passed");
process.exit(failed ? 1 : 0);
