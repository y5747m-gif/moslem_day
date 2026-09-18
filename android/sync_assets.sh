#!/usr/bin/env bash
# Sync the website into android/assets/www for APK bundling.
# The downloads/*.apk files are excluded (the app IS the download).
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
SITE=android/assets/www
rm -rf "$SITE"
mkdir -p "$SITE"
cp -r index.html css js app-info.json "$SITE/"
mkdir -p "$SITE/downloads"
cp downloads/readme-in-app.txt "$SITE/downloads/" 2>/dev/null || true
echo "synced: $(find "$SITE" -type f | wc -l) files"
