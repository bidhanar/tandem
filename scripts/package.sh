#!/usr/bin/env bash
# Builds the packages you send to someone: one folder that holds Mendu and
# its own copy of Node.js, so they don't have to install Node.
#
#   scripts/package.sh
#   MENDU_SYNC_SERVER=https://your-server.example scripts/package.sh
#
# Produces, in release/:
#   mendu-<version>-windows-x64.zip   unzip, then double-click Mendu.bat
#   mendu-<version>-linux-x64.tar.gz  extract, then run ./mendu
#
# MENDU_SYNC_SERVER sets the sync server address the package starts with, so
# the other person doesn't have to type it into Settings.
#
# Needs: node, npm, curl, zip, tar, xz, sha256sum. Works on Linux.

set -euo pipefail

NODE_VERSION=v22.23.5   # the Node.js put inside the packages
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/local/package.json').version")
CACHE=$ROOT/.cache/node
OUT=$ROOT/release
STAGE=$OUT/stage

rm -rf "$STAGE"
mkdir -p "$CACHE" "$STAGE/app/local"

echo "== Building Mendu $VERSION"
(cd "$ROOT/local" && npm ci --no-audit --no-fund >/dev/null && npx tsc)
cp -r "$ROOT/local/dist" "$ROOT/local/package.json" "$ROOT/local/package-lock.json" "$STAGE/app/local/"
rm -rf "$STAGE/app/local/dist/test"
(cd "$STAGE/app/local" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
mkdir "$STAGE/app/web"
cp "$ROOT"/web/*.html "$ROOT"/web/*.js "$ROOT"/web/*.css "$ROOT"/web/*.svg "$ROOT/web/package.json" "$STAGE/app/web/"
cp "$ROOT/LICENSE" "$STAGE/LICENSE.txt"
if [ -n "${MENDU_SYNC_SERVER:-}" ]; then
  printf '{ "sync_server": "%s" }\n' "$MENDU_SYNC_SERVER" > "$STAGE/app/defaults.json"
  echo "   sync server preset: $MENDU_SYNC_SERVER"
fi

# Downloads one Node.js archive (once) and checks it against Node's published checksum.
fetch_node() {
  local file=$1
  if [ ! -f "$CACHE/$file" ]; then
    echo "== Downloading $file"
    curl -fsSL -o "$CACHE/$file" "https://nodejs.org/dist/$NODE_VERSION/$file"
  fi
  [ -f "$CACHE/SHASUMS256-$NODE_VERSION.txt" ] ||
    curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$CACHE" && grep " $file\$" "SHASUMS256-$NODE_VERSION.txt" | sha256sum --check --quiet)
}

echo "== Windows package"
WIN=$OUT/Mendu-windows
rm -rf "$WIN" && mkdir -p "$WIN/runtime"
cp -r "$STAGE/app" "$STAGE/LICENSE.txt" "$WIN/"
fetch_node "node-$NODE_VERSION-win-x64.zip"
unzip -q -j "$CACHE/node-$NODE_VERSION-win-x64.zip" "node-$NODE_VERSION-win-x64/node.exe" -d "$WIN/runtime"
cp "$ROOT/packaging/Mendu.bat" "$ROOT/packaging/READ ME.txt" "$WIN/"
# Windows wants its own line endings in .bat and .txt files.
sed -i 's/$/\r/' "$WIN/Mendu.bat" "$WIN/READ ME.txt"
rm -f "$OUT/mendu-$VERSION-windows-x64.zip"
(cd "$OUT" && mv Mendu-windows Mendu && zip -qr "mendu-$VERSION-windows-x64.zip" Mendu && rm -rf Mendu)

echo "== Linux package"
LIN=$OUT/Mendu
mkdir -p "$LIN/runtime"
cp -r "$STAGE/app" "$STAGE/LICENSE.txt" "$LIN/"
fetch_node "node-$NODE_VERSION-linux-x64.tar.xz"
tar -xJf "$CACHE/node-$NODE_VERSION-linux-x64.tar.xz" -C "$LIN/runtime" --strip-components=2 "node-$NODE_VERSION-linux-x64/bin/node"
cp "$ROOT/packaging/mendu" "$ROOT/packaging/READ ME.txt" "$LIN/"
chmod +x "$LIN/mendu"
(cd "$OUT" && tar -czf "mendu-$VERSION-linux-x64.tar.gz" Mendu && rm -rf Mendu)

rm -rf "$STAGE"
echo "== Done"
ls -lh "$OUT"
