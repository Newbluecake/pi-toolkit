#!/usr/bin/env bash
# Package the versioned, externally installable web UI release attachment.
# Usage: scripts/release/package-web-ui.sh <version> [outDir]
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${1:?usage: package-web-ui.sh <version> [outDir]}"
VERSION="${VERSION#v}"
OUT_DIR="${2:-release}"
DIST_DIR="${PWH_UI_DIST:-dist/web-hub-ui}"
STAGE_DIR="$OUT_DIR/stage-ui"
ZIP="$OUT_DIR/pi-toolkit-web-ui-${VERSION}.zip"

[[ -f "$DIST_DIR/build-info.json" ]] || { echo "missing UI build-info.json: $DIST_DIR" >&2; exit 1; }
node - "$DIST_DIR/build-info.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [file, expected] = process.argv.slice(2);
const info = JSON.parse(fs.readFileSync(file, "utf8"));
if (info.version !== expected) {
  console.error(`UI version mismatch: ${info.version ?? "missing"} !== ${expected}`);
  process.exit(1);
}
NODE
if find "$DIST_DIR" -type l -print -quit | grep -q .; then
  echo "UI dist contains a symlink" >&2
  exit 1
fi

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/web-hub-ui/$VERSION"
cp -R "$DIST_DIR/." "$STAGE_DIR/web-hub-ui/$VERSION/"
chmod -R u=rwX,go=rX "$STAGE_DIR"
mkdir -p "$OUT_DIR"
rm -f "$ZIP" "$ZIP.sha256"
(cd "$STAGE_DIR" && zip -qrX "../pi-toolkit-web-ui-${VERSION}.zip" web-hub-ui)
(cd "$OUT_DIR" && sha256sum "pi-toolkit-web-ui-${VERSION}.zip" > "pi-toolkit-web-ui-${VERSION}.zip.sha256")
rm -rf "$STAGE_DIR"

