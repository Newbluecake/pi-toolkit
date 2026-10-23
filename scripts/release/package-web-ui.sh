#!/usr/bin/env bash
# Package the versioned, externally installable web UI release attachment.
# Usage: scripts/release/package-web-ui.sh <version> [outDir]
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${1:?usage: package-web-ui.sh <version> [outDir]}"
VERSION="${VERSION#v}"
OUT_DIR="${2:-release}"
DIST_DIR="${PWH_UI_DIST:-dist/web-hub-ui}"
NOTICES_SRC="${PWH_UI_NOTICES:-THIRD_PARTY_NOTICES.md}"
LICENSE_SRC="${PWH_UI_LICENSE:-LICENSE}"
STAGE_DIR="$OUT_DIR/stage-ui"
ZIP="$OUT_DIR/pi-toolkit-web-ui-${VERSION}.zip"

# The UI bundle carries third-party code (incl. EPL-2.0 elkjs): its licence texts MUST ride the zip
# (web-hub-mermaid plan §8.5). They go next to — never inside — the verified UI root `web-hub-ui/<ver>/`.
[[ -f "$NOTICES_SRC" ]] || { echo "missing third-party notices: $NOTICES_SRC" >&2; exit 1; }
[[ -f "$LICENSE_SRC" ]] || { echo "missing LICENSE: $LICENSE_SRC" >&2; exit 1; }
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
mkdir -p "$STAGE_DIR/web-hub-ui/$VERSION.licenses"
cp "$NOTICES_SRC" "$STAGE_DIR/web-hub-ui/$VERSION.licenses/THIRD_PARTY_NOTICES.md"
cp "$LICENSE_SRC" "$STAGE_DIR/web-hub-ui/$VERSION.licenses/LICENSE"
chmod -R u=rwX,go=rX "$STAGE_DIR"
mkdir -p "$OUT_DIR"
rm -f "$ZIP" "$ZIP.sha256"
(cd "$STAGE_DIR" && zip -qrX "../pi-toolkit-web-ui-${VERSION}.zip" web-hub-ui)
(cd "$OUT_DIR" && sha256sum "pi-toolkit-web-ui-${VERSION}.zip" > "pi-toolkit-web-ui-${VERSION}.zip.sha256")
rm -rf "$STAGE_DIR"

