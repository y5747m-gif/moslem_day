# Signing key — VocalPure release

* `vocalpure-release.key.pem` — RSA-2048 private key (self-signed cert)
* `vocalpure-release.crt` — certificate, CN=VocalPure, valid until 2056

These are committed intentionally so every build of this project produces
**update-compatible** APKs (Android only installs updates signed with the
same key). This is convenient for a demo/hobby app.

For a production app: generate a new key, store it in a secrets manager,
and do NOT commit it. Rotating away from this key requires APK signature
scheme v3 rotation history (proof-of-rotation), which this build does not
embed yet.
