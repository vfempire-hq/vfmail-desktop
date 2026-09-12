#!/usr/bin/env bash
# Generate the Tauri updater signing keypair.
# Public half goes into src-tauri/tauri.conf.json under plugins.updater.pubkey.
# Private half stays OFFLINE (or on the beast in ~/.vfmail-signing/).

set -euo pipefail
DEST="${HOME}/.vfmail-signing"
mkdir -p "$DEST"
if [[ -f "$DEST/vfmail.key" ]]; then
    echo "Signing key already exists at $DEST/vfmail.key — refusing to overwrite."
    echo "To rotate, move the old key aside first."
    exit 1
fi
cargo install tauri-cli@2 --locked
cargo tauri signer generate -w "$DEST/vfmail.key"
echo
echo "==> PRIVATE key (KEEP OFFLINE):"
echo "    $DEST/vfmail.key"
echo
echo "==> PUBLIC key (paste into src-tauri/tauri.conf.json → plugins.updater.pubkey):"
cat "$DEST/vfmail.key.pub"
echo
echo "You must NEVER commit the private key. Consider Shamir-splitting it (3-of-5)."
