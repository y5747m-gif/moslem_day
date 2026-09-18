#!/usr/bin/env bash
# Run every check for the VocalPure repo (site + standalone app).
#   tools/checks/run_all.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
FAIL=0
step() { echo; echo "=== $1 ==="; }

step "1/5  JS syntax (node --check)"
for f in js/site.js js/background.js app/js/isolation.js app/js/player.js; do
  if node --check "$f"; then echo "  ok: $f"; else FAIL=1; fi
done

step "2/5  HTML structure + JS references"
python3 tools/checks/check_html.py || FAIL=1

step "3/5  Numeric isolation engine checks"
node tools/checks/test_isolation.mjs || FAIL=1

step "4/5  App smoke test (jsdom, no audio stack)"
node tools/checks/smoke_app.mjs || FAIL=1

step "5/5  App audio pipeline wiring test (jsdom + WebAudio mock)"
node tools/checks/smoke_audio.mjs || FAIL=1

echo
if [ "$FAIL" -ne 0 ]; then
  echo "SOME CHECKS FAILED"
  exit 1
fi
echo "ALL CHECKS PASSED"
