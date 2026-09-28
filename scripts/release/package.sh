#!/usr/bin/env bash
# Stage 9 of the git-release flow: build and package the distributable.
#
# Usage: scripts/release/package.sh [version] [outDir]
# Produces the installable total zip, the versioned web UI zip, checksums, and
# CHANGELOG-<version>.md. Neither zip is published by this script.
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${1:-$(node -p "require('./package.json').version")}"
VERSION="${VERSION#v}"
OUT_DIR="${2:-release}"
STAGE_DIR="$OUT_DIR/stage/pi-toolkit"
ZIP="$OUT_DIR/pi-toolkit-${VERSION}.zip"

# Keep the source entrypoint and pi skills in the release: pi loads index.ts via
# jiti, while dist remains available to plain Node consumers.
echo "📦 packaging pi-toolkit v${VERSION}"
npm run build
npm run build:web
npm run check:web

rm -rf "$OUT_DIR/stage"
mkdir -p "$STAGE_DIR"
cp -r dist "$STAGE_DIR/dist"
cp -r src skills "$STAGE_DIR/"
cp index.ts index.js package.json README.md README.en.md LICENSE CHANGELOG.md "$STAGE_DIR/"

mkdir -p "$OUT_DIR"
rm -f "$ZIP" "$ZIP.sha256"
(cd "$OUT_DIR/stage" && zip -qrX "../pi-toolkit-${VERSION}.zip" pi-toolkit)
(cd "$OUT_DIR" && sha256sum "pi-toolkit-${VERSION}.zip" > "pi-toolkit-${VERSION}.zip.sha256")

scripts/release/package-web-ui.sh "$VERSION" "$OUT_DIR"

awk "flag && /^## \[/{exit} flag{print} /^## \[${VERSION}\]/{flag=1}" CHANGELOG.md \
  | sed -e '1{/^$/d}' > "$OUT_DIR/CHANGELOG-${VERSION}.md" || true

rm -rf "$OUT_DIR/stage"

echo "✅ $ZIP"
echo "✅ $ZIP.sha256"
echo "✅ $OUT_DIR/pi-toolkit-web-ui-${VERSION}.zip"
echo "✅ $OUT_DIR/pi-toolkit-web-ui-${VERSION}.zip.sha256"
echo "✅ $OUT_DIR/CHANGELOG-${VERSION}.md"
echo "ℹ️  Attach both zip files and their .sha256 files to the GitHub release (gh release create is not run here)."
