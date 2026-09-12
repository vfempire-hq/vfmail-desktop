#!/usr/bin/env bash
# VF Mail Desktop build helper.
# Run on Linux (beast) or Mac. Windows uses `cargo tauri build` directly.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# 1. system deps
if command -v apt-get >/dev/null; then
    echo "==> installing Tauri system deps (needs sudo)"
    sudo apt-get update
    sudo apt-get install -y \
        pkg-config libwebkit2gtk-4.1-dev \
        libgtk-3-dev libayatana-appindicator3-dev \
        librsvg2-dev libsoup-3.0-dev libssl-dev \
        mingw-w64
fi

# 2. rust toolchain
if ! command -v cargo >/dev/null; then
    echo "==> installing rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
source ~/.cargo/env

# 3. Windows cross-compile target
rustup target add x86_64-pc-windows-gnu || true

# 4. tauri cli
cargo install tauri-cli@2 --locked || true

# 5. build
echo "==> building Linux AppImage + Deb"
cargo tauri build

echo "==> building Windows installer"
cargo tauri build --target x86_64-pc-windows-gnu || echo "(skipped — install mingw-w64 to enable)"

echo
echo "==> Artifacts:"
find src-tauri/target -type f \( -name '*.msi' -o -name '*.exe' -o -name '*.AppImage' -o -name '*.deb' -o -name '*.dmg' \) 2>/dev/null | sort
