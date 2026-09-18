#!/usr/bin/env bash
# Bundle the standalone VocalPure app (app/) into android/assets/www.
# The APK ships ONLY the player app — the website is a separate
# download interface and is deliberately NOT bundled here.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
SITE=android/assets/www
rm -rf "$SITE"
mkdir -p "$SITE"
cp -r app/index.html app/css app/js "$SITE/"
echo "synced: $(find "$SITE" -type f | wc -l) files"
