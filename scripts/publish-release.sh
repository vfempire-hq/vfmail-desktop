#!/usr/bin/env bash
# Sign each installer with the Tauri updater key, then upload the artefacts
# + generated latest.json manifest to Cloudflare R2 (or any static bucket).
#
# Prereqs:
#   • $TAURI_SIGNING_PRIVATE_KEY_PATH — path to the .key file
#   • $TAURI_SIGNING_PRIVATE_KEY_PASSWORD — password (via secret manager)
#   • $R2_BUCKET, $R2_KEY_ID, $R2_SECRET, $R2_ENDPOINT — Cloudflare R2 creds
#   • $VERSION — semver, e.g. 0.2.0

set -euo pipefail
VERSION="${VERSION:?VERSION unset (e.g. VERSION=0.2.0)}"
NOTES="${NOTES:-See https://vfempire.com/updates/${VERSION}}"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${ROOT}/src-tauri/target/release/bundle"
STAGE="${ROOT}/build-out/${VERSION}"
rm -rf "$STAGE"
mkdir -p "$STAGE"

sign_and_stage() {
    local src="$1"
    local platform="$2"
    local out="${STAGE}/${platform}"
    mkdir -p "$out"
    local base
    base="$(basename "$src")"
    cp "$src" "$out/$base"
    # Signature file lives next to the installer (Tauri convention).
    if [[ -f "${src}.sig" ]]; then
        cp "${src}.sig" "$out/${base}.sig"
    else
        cargo tauri signer sign -k "$TAURI_SIGNING_PRIVATE_KEY_PATH" -f "$out/$base"
    fi
    printf '%s' "$(cat "$out/${base}.sig")"
}

WIN_SIG="$(sign_and_stage "${DIST}/nsis"/*setup.exe windows-x86_64 2>/dev/null || true)"
LNX_SIG="$(sign_and_stage "${DIST}/appimage"/*.AppImage linux-x86_64 2>/dev/null || true)"
MAC_SIG="$(sign_and_stage "${DIST}/dmg"/*.dmg darwin-aarch64 2>/dev/null || true)"

cat > "${STAGE}/latest.json" <<EOF
{
  "version": "${VERSION}",
  "notes": "${NOTES}",
  "pub_date": "${STAMP}",
  "platforms": {
    "windows-x86_64": { "signature": "${WIN_SIG}", "url": "https://updates.vfempire.com/vfmail/${VERSION}/windows-x86_64/VF_Mail_${VERSION}_x64-setup.exe" },
    "linux-x86_64":   { "signature": "${LNX_SIG}", "url": "https://updates.vfempire.com/vfmail/${VERSION}/linux-x86_64/VF_Mail_${VERSION}_amd64.AppImage" },
    "darwin-aarch64": { "signature": "${MAC_SIG}", "url": "https://updates.vfempire.com/vfmail/${VERSION}/darwin-aarch64/VF_Mail_${VERSION}.dmg" }
  }
}
EOF

echo "==> Manifest built at ${STAGE}/latest.json"
echo "Next: upload ${STAGE}/**/* to r2://vfmail-updates/vfmail/${VERSION}/"
echo "Then symlink /vfmail/latest.json → /vfmail/${VERSION}/latest.json in the Worker."
