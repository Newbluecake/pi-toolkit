#!/usr/bin/env bash
# Stage 9 of the git-release flow: build and package the distributable.
#
# Usage: scripts/release/package.sh [version]   (default: package.json version)
#
# Produces in release/:
#   pi-toolkit-<version>.zip        dist/ + package.json + README + LICENSE + CHANGELOG
#   pi-toolkit-<version>.zip.sha256 SHA256 checksum
#   CHANGELOG-<version>.md           this version's CHANGELOG section (release notes)
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${1:-$(node -p "require('./package.json').version")}"
VERSION="${VERSION#v}"
OUT_DIR="release"
STAGE_DIR="$OUT_DIR/stage/pi-toolkit"
ZIP="$OUT_DIR/pi-toolkit-${VERSION}.zip"

echo "📦 packaging pi-toolkit v${VERSION}"

npm run build

rm -rf "$OUT_DIR/stage"
mkdir -p "$STAGE_DIR"
cp -r dist "$STAGE_DIR/dist"
cp package.json README.md LICENSE CHANGELOG.md "$STAGE_DIR/"

mkdir -p "$OUT_DIR"
rm -f "$ZIP" "$ZIP.sha256"
(cd "$OUT_DIR/stage" && zip -qr "../pi-toolkit-${VERSION}.zip" pi-toolkit)
(cd "$OUT_DIR" && sha256sum "pi-toolkit-${VERSION}.zip" > "pi-toolkit-${VERSION}.zip.sha256")

# This version's CHANGELOG section → standalone release-notes file
awk "flag && /^## \[/{exit} flag{print} /^## \[${VERSION}\]/{flag=1}" CHANGELOG.md \
  | sed -e '1{/^$/d}' > "$OUT_DIR/CHANGELOG-${VERSION}.md" || true

rm -rf "$OUT_DIR/stage"

echo "✅ $ZIP"
echo "✅ $ZIP.sha256"
echo "✅ $OUT_DIR/CHANGELOG-${VERSION}.md"
