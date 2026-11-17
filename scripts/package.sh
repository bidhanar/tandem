#!/usr/bin/env bash
# Builds the packages you send to someone: one folder that holds Tandem and
# its own copy of Node.js, so they don't have to install Node.
#
#   scripts/package.sh
#   TANDEM_SYNC_SERVER=https://your-server.example scripts/package.sh
#
# Produces, in release/:
#   tandem-<version>-windows-x64.zip   unzip, then double-click Tandem.bat
#   tandem-<version>-linux-x64.tar.gz  extract, then run ./tandem
#   tandem-extension-<version>.zip     the browser extension (see README.md)
#
# TANDEM_SYNC_SERVER sets the sync server address the packages (and the
# extension) start with, so the other person doesn't have to type it in.
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

echo "== Building Tandem $VERSION"
(cd "$ROOT/local" && npm ci --no-audit --no-fund >/dev/null && npx tsc)
cp -r "$ROOT/local/dist" "$ROOT/local/package.json" "$ROOT/local/package-lock.json" "$STAGE/app/local/"
rm -rf "$STAGE/app/local/dist/test"
(cd "$STAGE/app/local" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
mkdir "$STAGE/app/web"
cp "$ROOT"/web/*.html "$ROOT"/web/*.js "$ROOT"/web/*.css "$ROOT"/web/*.svg "$ROOT/web/package.json" "$STAGE/app/web/"
cp "$ROOT/LICENSE" "$STAGE/LICENSE.txt"
if [ -n "${TANDEM_SYNC_SERVER:-}" ]; then
  printf '{ "sync_server": "%s" }\n' "$TANDEM_SYNC_SERVER" > "$STAGE/app/defaults.json"
  echo "   sync server preset: $TANDEM_SYNC_SERVER"
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
WIN=$OUT/Tandem-windows
rm -rf "$WIN" && mkdir -p "$WIN/runtime"
cp -r "$STAGE/app" "$STAGE/LICENSE.txt" "$WIN/"
fetch_node "node-$NODE_VERSION-win-x64.zip"
unzip -q -j "$CACHE/node-$NODE_VERSION-win-x64.zip" "node-$NODE_VERSION-win-x64/node.exe" -d "$WIN/runtime"
cp "$ROOT/packaging/Tandem.bat" "$ROOT/packaging/READ ME.txt" "$WIN/"
# Windows wants its own line endings in .bat and .txt files.
sed -i 's/$/\r/' "$WIN/Tandem.bat" "$WIN/READ ME.txt"
rm -f "$OUT/tandem-$VERSION-windows-x64.zip"
(cd "$OUT" && mv Tandem-windows Tandem && zip -qr "tandem-$VERSION-windows-x64.zip" Tandem && rm -rf Tandem)

echo "== Linux package"
LIN=$OUT/Tandem
mkdir -p "$LIN/runtime"
cp -r "$STAGE/app" "$STAGE/LICENSE.txt" "$LIN/"
fetch_node "node-$NODE_VERSION-linux-x64.tar.xz"
tar -xJf "$CACHE/node-$NODE_VERSION-linux-x64.tar.xz" -C "$LIN/runtime" --strip-components=2 "node-$NODE_VERSION-linux-x64/bin/node"
cp "$ROOT/packaging/tandem" "$ROOT/packaging/READ ME.txt" "$LIN/"
chmod +x "$LIN/tandem"
(cd "$OUT" && tar -czf "tandem-$VERSION-linux-x64.tar.gz" Tandem && rm -rf Tandem)

echo "== Browser extension"
EXT_VERSION=$(node -p "require('$ROOT/extension/package.json').version")
(cd "$ROOT/extension" && npm ci --no-audit --no-fund >/dev/null && npm test >/dev/null && npm run build >/dev/null)
rm -f "$OUT/tandem-extension-$EXT_VERSION.zip"
(cd "$ROOT/extension/dist" && zip -qr "$OUT/tandem-extension-$EXT_VERSION.zip" .)

rm -rf "$STAGE"
echo "== Done"
ls -lh "$OUT"
