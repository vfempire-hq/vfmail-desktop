<div align="center">

# ✉  VF Mail — Desktop

**Sovereign mail. Your keys. Your hardware. Your vault.**

End-to-end encrypted mail and direct messages, running on hardware you own,
against a mail server you control. Nothing about your messages is readable by
anyone but you and your recipient — not by us, not by ad-tech, not by
governments. There is no key material we could hand over even if compelled.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB.svg)](https://tauri.app)
[![Version](https://img.shields.io/badge/version-0.1.12-brightgreen.svg)](https://github.com/vfempire-hq/vfmail-desktop/releases)
[![security-scan](https://github.com/vfempire-hq/vfmail-desktop/actions/workflows/security-scan.yml/badge.svg)](https://github.com/vfempire-hq/vfmail-desktop/actions/workflows/security-scan.yml)

</div>

---

## Install

### Windows
```powershell
iex (iwr -useb https://inbox.vfempire.com/downloads/install.ps1).Content
```
Prebuilt NSIS installer, SHA-256 verified, ~30 seconds. No Rust, no VS Build Tools.

### Linux
```bash
curl -sSL https://inbox.vfempire.com/downloads/install.sh | bash
```
AppImage or .deb.

### macOS / iOS / Android
Coming with the paid launch on November 1, 2026.

### Build from source
```powershell
iex (iwr -useb https://inbox.vfempire.com/downloads/install-from-source.ps1).Content
```

---

## What VF Mail actually does

- **Vault-gated auto-login.** Your JMAP credentials live inside an
  age-encrypted vault sealed by your local password. The mailbox never
  appears without an unlock.
- **age (X25519) sealed mail between VF users.** When both sender and
  recipient are on VF Mail, the message body is age-sealed on the sender's
  device and can only be opened by the recipient's device. Everyone else —
  including our mail server — sees only ciphertext.
- **Ed25519 signed identity.** Every VF user has a published signing key.
  Every sealed message carries a detached signature that verifies the
  sender without exposing anything about them.
- **VF Sealed Channel (Phase 1).** Direct messages ride a purpose-built
  transport that hides envelope metadata. On the wire, the server sees only
  `{ recipient_id: sha256(pubkey), sealed_blob }`. It does NOT know which
  email addresses either party owns. Envelope hiding for VF↔VF traffic; SMTP
  fallback for talking to non-VF addresses with an explicit warning.
- **Signed auto-updater.** Every release ships with a minisign signature.
  Updates are verified before install.
- **Native Files.** Real filesystem-backed file management, not a JMAP hack.
  Runs on your disk, respects your OS.
- **Vault sync.** Syncthing, NAS, or your own cloud — pick your own
  transport. We do not host your vault.

---

## What VF Mail deliberately does NOT do

- Ship a telemetry pipe, an analytics library, or a "usage reporting" toggle.
- Send your outbox to an "AI summariser" running in someone else's cloud.
- Share your address book with a spam detection service.
- Fetch fonts, icons, or any resource from a CDN we don't operate.
- Have any way for us to read your mail or direct messages.

---

## The trust model in one line

> The private key of your identity is encrypted with your vault password and
> lives on your device. Nothing that touches the network can read your mail.

If you want the long version, read [`src-tauri/src/mail_crypto.rs`](src-tauri/src/mail_crypto.rs)
and [`src-tauri/src/channel.rs`](src-tauri/src/channel.rs). We wrote them so
they'd be readable.

---

## Layout

```
vfmail-desktop/
├── dist/                       Frontend (HTML/CSS/JS — shared with web build)
│   ├── index.html              Wires vault-shell + native adapter
│   ├── app.js / app.css        Mail client
│   ├── dm.js                   Direct messages (Sealed Channel)
│   ├── vf-crypto.js            Client bindings for Rust crypto commands
│   ├── vf-sync.js              Vault sync UI
│   ├── vault-shell.js          Vault-lock hero screen
│   └── vf-ui.js                Shared UI primitives
├── src-tauri/                  Rust core
│   ├── src/
│   │   ├── vault.rs            age-encrypted vault lifecycle
│   │   ├── identity.rs         age + Ed25519 keypair generation
│   │   ├── mail_crypto.rs      Seal + open sealed mail bodies
│   │   ├── channel.rs          VF Sealed Channel client
│   │   ├── keydir.rs           Public-key directory lookup
│   │   ├── fsops.rs            Native filesystem operations
│   │   └── sync.rs             Vault sync detection + config
│   └── tauri.conf.json         App metadata + updater config
├── updater-worker/             Cloudflare Worker for signed update manifests
├── scripts/                    Build + release helpers
└── ship-update.sh              One-command update lane for internal use
```

---

## Reproducible build

Every shipped binary is buildable from this repo. To verify:

```bash
git clone https://github.com/vfempire-hq/vfmail-desktop
cd vfmail-desktop/src-tauri
cargo tauri build
# Compare your SHA-256 to the one published at:
#   https://inbox.vfempire.com/downloads/vfmail-latest-x64-setup.exe.sha256
```

If they diverge, [open an issue](https://github.com/vfempire-hq/vfmail-desktop/issues) — that's a security bug.

---

## Security

Vulnerability reports: `security@vfempire.com` or via VF Mail itself. PGP key at [vfempire.com/.well-known/pgp.asc](https://vfempire.com/.well-known/pgp.asc). See [SECURITY.md](https://github.com/vfempire-hq/vfempire-hq/blob/main/SECURITY.md) in the org profile for full policy.

## License

[AGPL-3.0](LICENSE) — if you host a modified version of VF Mail as a
service, you must share your modifications with your users. If you want
commercial terms without the copyleft, contact `licensing@vfempire.com`.

---

<div align="center">
<sub>© 2026 VF Empire Corp Ltd · <a href="https://vfempire.com">vfempire.com</a> · Malta C 94160</sub>
</div>
