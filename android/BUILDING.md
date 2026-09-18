# Building the VocalPure APK (no Android SDK required)

The APK is built by `build_apk.py`, a self-contained pipeline that needs only:

* **aapt2** — vendored binary (from the `aaptjs3` npm package)
* **javac 8** — JDK8 `tools.jar` (npm `dataslope-tools-jar`) run on any JRE
  (e.g. `pip install jdk4py`)
* **dx** — AOSP dx compiled from source (vendored in
  `CodingGay/BlackObfuscator` on GitHub)
* **android.jar** — API 25 platform stubs (`Sable/android-platforms` mirror)
* **openssl** — JAR v1 signature + RSA signatures for schemes v2/v3

`bootstrap_tools.sh` downloads/compiles all of the above into `$VP_TOOLS`
(default `/opt/build/tools`).

## One-time setup

```bash
pip install jdk4py                      # provides a JRE (java binary)
export VP_JAVA=$(python3 -c 'import jdk4py; print(jdk4py.JAVA)')
./android/bootstrap_tools.sh
```

## Build + sync

```bash
./android/sync_assets.sh                # copies the site into android/assets/www
python3 android/build_apk.py \
    --version-name 2.4.1 --version-code 241 \
    --out downloads/VocalPure-v2.4.1.apk
```

Every build is verified inside the script:

* `androguard` re-parses the APK (manifest, dex, resources) and checks that
  signature schemes **v1, v2 and v3** are all present and well-formed
* `verify_apk.py` is an independent, byte-exact re-implementation of the
  AOSP v2/v3 verifiers: it recomputes the 3-section chunked content digest
  (`0xa5`/`0x5a` framing) and validates the RSA-SHA256 PKCS#1 signatures with
  openssl, then confirms the certificate matches the signer public key
* the JAR v1 chain is verified with `openssl cms -verify` plus a manual
  re-computation of every `MANIFEST.MF` / `CERT.SF` digest

Run the standalone verifier any time:

```bash
python3 android/verify_apk.py downloads/*.apk
```

## Signing key

`keystore/vocalpure-release.*` is the release key **committed on purpose** so
that future builds produce update-compatible APKs (Android refuses updates
signed with a different key). It is a self-signed 2048-bit RSA certificate
valid until 2056. For a production release, replace it with a properly
guarded key and never commit it.

## Pipeline summary

```
res/ ──aapt2 compile+link──▶ base.apk (manifest + resources)
MainActivity.java ──javac8──▶ .class ──dx──▶ classes.dex
base.apk + classes.dex + assets/www ──zip assemble (aligned)──▶ unsigned.apk
unsigned.apk ──JAR v1 (openssl smime)──▶ +META-INF/*
           ──APK Sig Block v2+v3 (this repo)──▶ signed, installable APK
```
