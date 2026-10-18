#!/bin/bash
# Regenerate every README screenshot end to end. See README.md. Scratch dir: $README_SHOTS_DIR (default ~/readme-shots).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
export README_SHOTS_DIR="${README_SHOTS_DIR:-$HOME/readme-shots}"
mkdir -p "$README_SHOTS_DIR"
cd "$REPO"
[ -f dist/web-hub-ui/build-info.json ] && [ -z "$REBUILD_WEB" ] || npm run build:web >/dev/null
node "$HERE/make-fixture.mjs"                              # fixtures/demo-{zh,en}.json (synthetic dev-hub scenarios)
npx tsx "$HERE/shoot-web.mts"                              # raw-web-*.png
"$HERE/tui/capture.sh"                                     # tui/shot.ansi (real pi in tmux, isolated HOME)
npx tsx "$HERE/tui/ansi2png.mts" "$README_SHOTS_DIR/tui/shot.ansi" "$README_SHOTS_DIR/raw-tui.png"
python3 "$HERE/optimize.py"                                # final/*.png
echo "done -> $README_SHOTS_DIR/final (copy to docs/images/)"
