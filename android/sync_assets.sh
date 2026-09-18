#!/usr/bin/env bash
# Sync the standalone app into android/assets/www for APK bundling.
# NOTE: the app is a SEPARATE product from the website — only app/ is
# bundled. The website (index.html, css/, js/) stays out of the APK.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
SITE=android/assets/www
rm -rf "$SITE"
mkdir -p "$SITE"
cp app/index.html app/app.js app/style.css app/app-info.json "$SITE/"
echo "synced: $(find "$SITE" -type f | wc -l) app files"
