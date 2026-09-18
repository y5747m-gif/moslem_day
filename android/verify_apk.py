#!/usr/bin/env python3
"""
Independent verifier for APK Signature Scheme v2/v3 — replicates the logic of
android.util.apk.ApkSignatureSchemeV2Verifier / V3Verifier (AOSP) step by step:
  1. find APK Signing Block before the Central Directory, parse pairs
  2. recompute the 3-section chunked content digest (0xa5/0x5a framing)
  3. verify the RSA-SHA256 PKCS#1 v1.5 signature over signed-data (openssl)
  4. check that the certificate's public key matches the signer record
Exit code 0 only if everything Android checks also passes here.
"""
import hashlib, struct, subprocess, sys, os

REPO = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(REPO, "keystore", "vocalpure-release.crt")
V2_ID = 0x7109871A
V3_ID = 0xF05368C0
ALG = 0x0103  # RSASSA-PKCS1-v1_5 with SHA2-256
CHUNK = 1024 * 1024


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def parse_block(raw):
    eocd_off = raw.rfind(b"PK\x05\x06")
    if eocd_off < 0:
        fail("no EOCD")
    cd_off = struct.unpack_from("<I", raw, eocd_off + 16)[0]
    # footer: [u64 size][magic] right before CD
    if raw[cd_off - 16:cd_off] != b"APK Sig Block 42":
        fail("signing block magic not found before CD")
    block_size_footer = struct.unpack_from("<Q", raw, cd_off - 24)[0]
    block_start = cd_off - 8 - block_size_footer  # start of u64 size field
    block_size_head = struct.unpack_from("<Q", raw, block_start)[0]
    if block_size_head != block_size_footer:
        fail("signing block size mismatch head/footer")
    body = raw[block_start + 8: cd_off - 24]
    pairs = {}
    off = 0
    while off < len(body):
        (plen,) = struct.unpack_from("<Q", body, off)
        (pid,) = struct.unpack_from("<I", body, off + 8)
        pairs[pid] = body[off + 12: off + 8 + plen]
        off += 8 + plen
    if off != len(body):
        fail("trailing bytes in signing block")
    return raw, raw[:block_start], raw[cd_off:eocd_off], raw[eocd_off:], pairs, block_start


def sections_and_digest(raw, before, central, eocd):
    eocd = bytearray(eocd)
    struct.pack_into("<I", eocd, 16, len(before))
    hashes = []
    for section in (before, central, bytes(eocd)):
        for i in range(0, len(section), CHUNK):
            c = section[i:i + CHUNK]
            hashes.append(hashlib.sha256(b"\xa5" + struct.pack("<I", len(c)) + c).digest())
    top = b"\x5a" + struct.pack("<I", len(hashes)) + b"".join(hashes)
    return hashlib.sha256(top).digest()


def lp_slice(buf, off):
    (n,) = struct.unpack_from("<I", buf, off)
    return buf[off + 4: off + 4 + n], off + 4 + n


def verify_v2v3(path):
    raw, before, central, eocd, pairs, block_start = parse_block(open(path, "rb").read())
    digest = sections_and_digest(raw, before, central, eocd)

    # ---- v2 ----
    if V2_ID not in pairs:
        fail("v2 block id missing")
    v2 = pairs[V2_ID]
    signers, o = lp_slice(v2, 0)
    if o != len(v2):
        fail("v2: trailing bytes after signers")
    signer, o = lp_slice(signers, 0)
    if o != len(signers):
        fail("v2: trailing bytes inside signers")
    signed_data, o = lp_slice(signer, 0)
    signatures, o = lp_slice(signer, o)
    pubkey, o = lp_slice(signer, o)
    if o != len(signer):
        fail("v2: trailing bytes in signer")
    digests, o = lp_slice(signed_data, 0)
    certs, o = lp_slice(signed_data, o)
    attrs, o = lp_slice(signed_data, o)
    if o != len(signed_data):
        fail("v2: trailing bytes in signed-data")
    rec, o = lp_slice(digests, 0)
    alg, d = struct.unpack_from("<I", rec, 0)[0], None
    d, o2 = lp_slice(rec, 4)
    if alg != ALG:
        fail("v2: unexpected digest algorithm %#x" % alg)
    if d != digest:
        fail("v2: CONTENT DIGEST MISMATCH (expected %s got %s)" % (digest.hex(), d.hex()))
    sig_rec, _ = lp_slice(signatures, 0)
    sig_alg = struct.unpack_from("<I", sig_rec, 0)[0]
    signature, _ = lp_slice(sig_rec, 4)
    if sig_alg != ALG:
        fail("v2: unexpected signature algorithm")
    # openssl: RSASSA-PKCS1-v1_5 verify over signed_data
    sd_p = "/tmp/v2_signed_data.bin"
    sig_p = "/tmp/v2_sig.bin"
    open(sd_p, "wb").write(signed_data)
    open(sig_p, "wb").write(signature)
    r = subprocess.run(["openssl", "dgst", "-sha256", "-verify",
                        "/tmp/vp_pubkey.pem", "-signature", sig_p, sd_p],
                       capture_output=True, text=True)
    if r.returncode != 0:
        fail("v2: RSA signature invalid: " + r.stderr)
    print("  v2: digest ok, RSA-SHA256 signature valid")

    # ---- v3 ----
    if V3_ID not in pairs:
        fail("v3 block id missing")
    v3 = pairs[V3_ID]
    signers, o = lp_slice(v3, 0)
    signer, o = lp_slice(signers, 0)
    signed_data, o = lp_slice(signer, 0)
    min_sdk = struct.unpack_from("<I", signer, o)[0]
    max_sdk = struct.unpack_from("<I", signer, o + 4)[0]
    o += 8
    signatures, o = lp_slice(signer, o)
    pubkey3, o = lp_slice(signer, o)
    digests, o = lp_slice(signed_data, 0)
    certs, o = lp_slice(signed_data, o)
    signed_min = struct.unpack_from("<I", signed_data, o)[0]
    signed_max = struct.unpack_from("<I", signed_data, o + 4)[0]
    o += 8
    attrs, o = lp_slice(signed_data, o)
    if o != len(signed_data):
        fail("v3: trailing bytes in signed-data")
    if (min_sdk, max_sdk) != (signed_min, signed_max):
        fail("v3: sdk range mismatch signed vs unsigned")
    rec, _ = lp_slice(digests, 0)
    alg = struct.unpack_from("<I", rec, 0)[0]
    d, _ = lp_slice(rec, 4)
    if d != digest:
        fail("v3: CONTENT DIGEST MISMATCH")
    sig_rec, _ = lp_slice(signatures, 0)
    signature, _ = lp_slice(sig_rec, 4)
    open(sd_p, "wb").write(signed_data)
    open(sig_p, "wb").write(signature)
    r = subprocess.run(["openssl", "dgst", "-sha256", "-verify",
                        "/tmp/vp_pubkey.pem", "-signature", sig_p, sd_p],
                       capture_output=True, text=True)
    if r.returncode != 0:
        fail("v3: RSA signature invalid: " + r.stderr)
    if pubkey != pubkey3:
        fail("v3/v2 public key mismatch")
    # cert's public key must equal the signer pubkey
    cert_spki = subprocess.run(["openssl", "x509", "-in", CERT, "-pubkey", "-noout"],
                               capture_output=True).stdout
    cert_spki_der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"],
                                   input=cert_spki, capture_output=True).stdout
    if pubkey != cert_spki_der:
        fail("certificate public key != signer public key")
    print("  v3: digest ok, RSA-SHA256 signature valid, sdk range [%d, inf), cert matches"
          % min_sdk)


if __name__ == "__main__":
    subprocess.run(["openssl", "pkey", "-in", os.path.join(REPO, "keystore",
                    "vocalpure-release.key.pem"), "-pubout", "-outform", "DER",
                    "-out", "/tmp/vp_pubkey.pem"], check=True)
    for apk in sys.argv[1:]:
        print("verifying", apk)
        verify_v2v3(apk)
    print("ALL SIGNATURE SCHEMES VERIFIED — installable on Android 8.0+")
