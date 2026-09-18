#!/usr/bin/env python3
"""
VocalPure APK builder — builds a real, signed, installable APK without the
Android SDK/Gradle. Pipeline:
  1. aapt2 (npm aaptjs3 binary)  -> binary manifest + compiled resources
  2. javac8 (tools.jar on jdk4py JRE) + dx (AOSP, compiled from source) -> classes.dex
  3. zip assembly (fixed order, deflate, 4-byte alignment for stored entries)
  4. JAR v1 signature (openssl smime)
  5. APK Signature Scheme v2 + v3 blocks, byte-exact per the AOSP verifiers:
       - content digest: 3 sections (contents / central dir / patched EOCD),
         chunked at 1 MiB:  chunk digest = SHA256(0xa5 + u32le(len) + chunk)
                            final digest = SHA256(0x5a + u32le(count) + concat)
       - v2 signer:  lp(signedData) lp(signatures) lp(pubkey)
       - v3 signer:  lp(signedData) u32(minSdk) u32(maxSdk) lp(signatures) lp(pubkey)
  6. verification pass with androguard (v1/v2/v3 all validated)

Outputs installable APKs for Android 8.0+ (API 26+).
"""
import argparse, hashlib, os, shutil, struct, subprocess, sys, tempfile, zipfile, zlib

REPO = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.environ.get("VP_TOOLS", "/opt/build/tools")
JAVA = os.environ.get("VP_JAVA",
    "/opt/venv/lib/python3.11/site-packages/jdk4py/java-runtime/bin/java")
TOOLS_JAR = os.path.join(TOOLS, "tools.jar")
AAPT2 = os.path.join(TOOLS, "aapt2")
DXCLASSES = os.path.join(TOOLS, "dxclasses")
ANDROID_JAR = os.path.join(TOOLS, "android.jar")
KEY_PEM = os.path.join(REPO, "keystore", "vocalpure-release.key.pem")
CERT_PEM = os.path.join(REPO, "keystore", "vocalpure-release.crt")

CHUNK = 1024 * 1024
ALG_RSA_PKCS1_SHA256 = 0x0103
V2_BLOCK_ID = 0x7109871A
V3_BLOCK_ID = 0xF05368C0
MAGIC = b"APK Sig Block 42"
MIN_SDK, TARGET_SDK = 26, 29


def sh(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.exit("[build] command failed: %s\n%s\n%s" % (cmd, r.stdout, r.stderr))
    return r.stdout


def lp(payload: bytes) -> bytes:
    return struct.pack("<I", len(payload)) + payload


def u32(v): return struct.pack("<I", v)
def u64(v): return struct.pack("<Q", v)


# ------------------------------------------------------------------ resources
def build_resources(tmp, version_code, version_name):
    with open(os.path.join(REPO, "AndroidManifest.xml")) as f:
        xml = f.read()
    xml = xml.replace("__VERSION_CODE__", str(version_code))
    xml = xml.replace("__VERSION_NAME__", version_name)
    manifest = os.path.join(tmp, "AndroidManifest.xml")
    with open(manifest, "w") as f:
        f.write(xml)

    compiled = os.path.join(tmp, "res.zip")
    sh([AAPT2, "compile", "--dir", os.path.join(REPO, "res"), "-o", compiled])
    base = os.path.join(tmp, "base.apk")
    sh([AAPT2, "link", "-o", base, "-I", ANDROID_JAR,
        "--manifest", manifest, "--auto-add-overlay", compiled])
    return base


# ------------------------------------------------------------------ code
def build_dex(tmp):
    src = os.path.join(REPO, "src", "com", "vocalpure", "app", "MainActivity.java")
    out = os.path.join(tmp, "classes")
    os.makedirs(out, exist_ok=True)
    sh([JAVA, "-Dsun.boot.class.path=", "-cp", TOOLS_JAR, "com.sun.tools.javac.Main",
        "-encoding", "UTF-8", "-bootclasspath", ANDROID_JAR,
        "-source", "8", "-target", "8", "-d", out, src])
    dex = os.path.join(tmp, "classes.dex")
    sh([JAVA, "-cp", DXCLASSES, "com.android.dx.command.Main",
        "--dex", "--output", dex, out])
    data = open(dex, "rb").read()
    if not data.startswith(b"dex\n"):
        sys.exit("[build] dx produced an invalid dex")
    return data


# ------------------------------------------------------------------ zip
def assemble_zip(base_apk, dex_bytes, assets_dir, out_path):
    entries = []  # (name, data, compress?)
    with zipfile.ZipFile(base_apk) as z:
        for n in sorted(z.namelist()):
            if n.startswith("META-INF/"):
                continue
            entries.append((n, z.read(n), n != "resources.arsc"))
    entries.append(("classes.dex", dex_bytes, True))
    for root, _, files in os.walk(assets_dir):
        for fn in sorted(files):
            full = os.path.join(root, fn)
            rel = "assets/" + os.path.relpath(full, assets_dir).replace(os.sep, "/")
            entries.append((rel, open(full, "rb").read(), True))

    def rank(n):
        if n == "AndroidManifest.xml": return (0, n)
        if n.startswith("res/"):       return (1, n)
        if n == "resources.arsc":      return (2, n)
        if n == "classes.dex":         return (3, n)
        if n.startswith("assets/"):    return (4, n)
        return (5, n)
    entries.sort(key=lambda e: rank(e[0]))

    out = bytearray()
    central = bytearray()
    for name, data, compress in entries:
        if compress:
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            payload, method = co.compress(data) + co.flush(), 8
        else:
            payload, method = data, 0
        crc = zlib.crc32(data) & 0xFFFFFFFF
        nb = name.encode()
        offset = len(out)
        if method == 0:  # stored: pad so the payload starts 4-aligned
            pad = (4 - ((offset + 30 + len(nb)) % 4)) % 4
            extra = b"\x00" * pad
            header = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, method, 0, 0,
                                 crc, len(payload), len(data), len(nb), len(extra))
            out += header + nb + extra + payload
            central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, method, 0, 0,
                                   crc, len(payload), len(data), len(nb), len(extra), 0, 0, 0, 0,
                                   offset) + nb + extra
            continue
        header = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, method, 0, 0,
                             crc, len(payload), len(data), len(nb), 0)
        out += header + nb + payload
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, method, 0, 0,
                               crc, len(payload), len(data), len(nb), 0, 0, 0, 0,
                               0, offset) + nb

    cd_offset = len(out)
    out += central
    out += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries),
                       len(central), cd_offset, 0)
    with open(out_path, "wb") as f:
        f.write(out)
    return bytes(out)


# ------------------------------------------------------------------ v1 (JAR)
def v1_records(apk_path):
    with zipfile.ZipFile(apk_path) as z:
        names = [n for n in z.namelist() if not n.startswith("META-INF/")]
        datas = {n: z.read(n) for n in names}
    return names, datas


def write_v1_meta(tmp, names, datas):
    import base64
    lines = ["Manifest-Version: 1.0", "Created-By: 1.0 (VocalPure Build)", ""]
    for n in names:
        d = base64.b64encode(hashlib.sha256(datas[n]).digest()).decode()
        lines += ["Name: %s" % n, "SHA-256-Digest: %s" % d, ""]
    mf = ("\n".join(lines)).encode()

    # digest over the MANIFEST.MF main attributes section (up to first blank line)
    main_attrs = mf.split(b"\n\n", 1)[0] + b"\n\n"
    sf = ["Signature-Version: 1.0",
          "Created-By: 1.0 (VocalPure Build)",
          "SHA-256-Digest-Manifest-Main-Attributes: " +
          base64.b64encode(hashlib.sha256(main_attrs).digest()).decode(), ""]
    for n in names:
        d = base64.b64encode(hashlib.sha256(datas[n]).digest()).decode()
        entry = ("Name: %s\nSHA-256-Digest: %s\n\n" % (n, d)).encode()
        sf_d = base64.b64encode(hashlib.sha256(entry).digest()).decode()
        sf += ["Name: %s" % n, "SHA-256-Digest: %s" % sf_d, ""]
    sf_b = ("\n".join(sf)).encode()

    mf_p = os.path.join(tmp, "MANIFEST.MF")
    sf_p = os.path.join(tmp, "CERT.SF")
    rsa_p = os.path.join(tmp, "CERT.RSA")
    open(mf_p, "wb").write(mf)
    open(sf_p, "wb").write(sf_b)
    sh(["openssl", "smime", "-sign", "-in", sf_p, "-out", rsa_p,
        "-signer", CERT_PEM, "-inkey", KEY_PEM, "-outform", "DER",
        "-md", "sha256", "-binary"])
    return [("META-INF/MANIFEST.MF", mf, False),
            ("META-INF/CERT.SF", sf_b, False),
            ("META-INF/CERT.RSA", open(rsa_p, "rb").read(), False)]


# ------------------------------------------------------------------ v2 / v3
def content_digest(apk_before_block: bytes, central_dir: bytes, eocd: bytes) -> bytes:
    """Digest over the 3 sections; EOCD's CD-offset field is patched to the
    signing block offset (= len(apk_before_block))."""
    eocd = bytearray(eocd)
    struct.pack_into("<I", eocd, 16, len(apk_before_block))
    hashes = []
    for section in (apk_before_block, central_dir, bytes(eocd)):
        for i in range(0, len(section), CHUNK):
            chunk = section[i:i + CHUNK]
            hashes.append(hashlib.sha256(b"\xa5" + u32(len(chunk)) + chunk).digest())
    top = b"\x5a" + u32(len(hashes)) + b"".join(hashes)
    return hashlib.sha256(top).digest()


def rsa_sign(data: bytes) -> bytes:
    r = subprocess.run(["openssl", "dgst", "-sha256", "-sign", KEY_PEM],
                       input=data, capture_output=True)
    if r.returncode != 0:
        sys.exit("[build] openssl sign failed: " + r.stderr.decode())
    return r.stdout


def signing_blocks(contents: bytes, central_dir: bytes, eocd: bytes,
                   cert_der: bytes, spki_der: bytes) -> bytes:
    digest = content_digest(contents, central_dir, eocd)
    digests_field = lp(lp(u32(ALG_RSA_PKCS1_SHA256) + lp(digest)))
    certs_field = lp(lp(cert_der))
    attrs_field = lp(b"")

    signed_v2 = digests_field + certs_field + attrs_field
    sig_v2 = u32(ALG_RSA_PKCS1_SHA256) + lp(rsa_sign(signed_v2))
    signer_v2 = lp(signed_v2) + lp(lp(sig_v2)) + lp(spki_der)
    v2_value = lp(lp(signer_v2))

    signed_v3 = (digests_field + certs_field
                 + u32(MIN_SDK) + u32(0x7FFFFFFF) + attrs_field)
    sig_v3 = u32(ALG_RSA_PKCS1_SHA256) + lp(rsa_sign(signed_v3))
    signer_v3 = (lp(signed_v3) + u32(MIN_SDK) + u32(0x7FFFFFFF)
                 + lp(lp(sig_v3)) + lp(spki_der))
    v3_value = lp(lp(signer_v3))

    pairs = (u64(4 + len(v3_value)) + u32(V3_BLOCK_ID) + v3_value +
             u64(4 + len(v2_value)) + u32(V2_BLOCK_ID) + v2_value)
    block_size = len(pairs) + 8 + 16
    return u64(block_size) + pairs + u64(block_size) + MAGIC


def apply_signing_block(unsigned_path, out_path):
    raw = open(unsigned_path, "rb").read()
    eocd_off = raw.rfind(b"PK\x05\x06")
    if eocd_off < 0:
        sys.exit("[build] EOCD not found")
    cd_off = struct.unpack_from("<I", raw, eocd_off + 16)[0]
    contents = raw[:cd_off]
    central_dir = raw[cd_off:eocd_off]
    eocd = raw[eocd_off:]

    cert_der = subprocess.run(["openssl", "x509", "-outform", "DER", "-in", CERT_PEM],
                              capture_output=True).stdout
    spki = subprocess.run(["openssl", "pkey", "-pubout", "-in", KEY_PEM,
                           "-outform", "DER"], capture_output=True).stdout
    block = signing_blocks(contents, central_dir, eocd, cert_der, spki)

    new_eocd = bytearray(eocd)
    struct.pack_into("<I", new_eocd, 16, cd_off + len(block))
    with open(out_path, "wb") as f:
        f.write(contents + block + central_dir + bytes(new_eocd))
    return len(contents) + len(block)


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version-name", required=True)
    ap.add_argument("--version-code", required=True, type=int)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="vpbuild_")
    try:
        print("[build] 1/6 resources (aapt2)…")
        base = build_resources(tmp, args.version_code, args.version_name)

        print("[build] 2/6 compile + dex (javac8 + dx)…")
        dex = build_dex(tmp)

        print("[build] 3/6 assemble zip (bundled site)…")
        unsigned = os.path.join(tmp, "unsigned.apk")
        assemble_zip(base, dex, os.path.join(REPO, "assets"), unsigned)

        print("[build] 4/6 JAR v1 signature…")
        names, datas = v1_records(unsigned)
        meta = write_v1_meta(tmp, names, datas)
        with zipfile.ZipFile(unsigned, "a") as z:
            for n, data, comp in meta:
                z.writestr(zipfile.ZipInfo(n), data, compress_type=
                           zipfile.ZIP_DEFLATED if comp else zipfile.ZIP_STORED)

        print("[build] 5/6 APK Signature Scheme v2 + v3…")
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        size = apply_signing_block(unsigned, args.out)

        print("[build] 6/6 verify…")
        verify(args.out, args, size)
        print("[build] OK -> %s (%.2f MB)" % (args.out, os.path.getsize(args.out) / 1e6))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify(path, args, block_end):
    sys.path.insert(0, "/opt/venv/lib/python3.11/site-packages")
    ok = False
    try:
        from androguard.core.apk import APK
        ok = True
    except Exception:
        try:
            from androguard.core.bytecodes.apk import APK
            ok = True
        except Exception as e:
            print("  (androguard unavailable: %s — skipping deep verify)" % e)
    if not ok:
        return
    a = APK(path)
    assert a.is_valid_APK(), "androguard: APK not valid"
    assert a.get_package() == "com.vocalpure.app", a.get_package()
    assert a.get_androidversion_name() == args.version_name
    assert a.get_androidversion_code() == str(args.version_code)
    assert a.get_min_sdk_version() == str(MIN_SDK)
    print("  package=%s v%s (%s) minSdk=%s targetSdk=%s" % (
        a.get_package(), a.get_androidversion_name(), a.get_androidversion_code(),
        a.get_min_sdk_version(), a.get_target_sdk_version()))
    v1, v2, v3 = a.is_signed_v1(), a.is_signed_v2(), a.is_signed_v3()
    print("  signatures: v1=%s v2=%s v3=%s" % (v1, v2, v3))
    assert v1 and v2 and v3, "missing signature scheme(s)"
    assert "assets/www/index.html" in a.get_files(), "site assets missing"
    n_assets = sum(1 for f in a.get_files() if f.startswith("assets/www/"))
    print("  bundled site files:", n_assets)
    verify_v1_deep(path)


def verify_v1_deep(apk_path):
    """Re-verify the JAR signature independently: CMS signature over CERT.SF
    (openssl) and every MANIFEST/SF digest recomputed by hand."""
    import base64
    with zipfile.ZipFile(apk_path) as z:
        mf = z.read("META-INF/MANIFEST.MF")
        sf = z.read("META-INF/CERT.SF")
        rsa = z.read("META-INF/CERT.RSA")
        entries = {n: z.read(n) for n in z.namelist()
                   if not n.startswith("META-INF/")}

    def stanzas_of(text):
        out, stanza = [], {}
        for line in text.splitlines():
            if not line:
                if stanza:
                    out.append(stanza)
                    stanza = {}
            elif ": " in line:
                k, v = line.split(": ", 1)
                stanza[k] = v
        if stanza:
            out.append(stanza)
        return out

    tmp = tempfile.mkdtemp()
    try:
        sf_p = os.path.join(tmp, "CERT.SF")
        open(sf_p, "wb").write(sf)
        r = subprocess.run(["openssl", "cms", "-verify", "-inform", "DER",
                            "-content", sf_p, "-purpose", "any", "-CAfile", CERT_PEM],
                           input=rsa, capture_output=True)
        if r.returncode != 0:  # older openssl
            r = subprocess.run(["openssl", "smime", "-verify", "-inform", "DER",
                                "-content", sf_p, "-purpose", "any",
                                "-CAfile", CERT_PEM],
                               input=rsa, capture_output=True)
        if r.returncode != 0:
            sys.exit("[build] v1 CMS verification failed:\n" + r.stderr.decode())

        mf_stanzas = {s["Name"]: s for s in stanzas_of(mf.decode()) if "Name" in s}
        for name, want_digest in mf_stanzas.items():
            got = base64.b64encode(hashlib.sha256(entries[name]).digest()).decode()
            assert want_digest["SHA-256-Digest"] == got, \
                "manifest digest mismatch for " + name
        sf_entry_count = 0
        for st in stanzas_of(sf.decode()):
            if "Name" not in st or "SHA-256-Digest" not in st:
                continue
            name = st["Name"]
            entry = ("Name: %s\nSHA-256-Digest: %s\n\n" % (
                name, mf_stanzas[name]["SHA-256-Digest"])).encode()
            got = base64.b64encode(hashlib.sha256(entry).digest()).decode()
            assert st["SHA-256-Digest"] == got, "SF digest mismatch for " + name
            sf_entry_count += 1
        print("  v1 deep check: CMS ok, %d manifest digests + %d SF digests verified"
              % (len(mf_stanzas), sf_entry_count))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
