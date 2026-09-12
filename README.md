# VF Mail — Desktop

**Sovereign mail. Your keys. Your hardware. Your vault.**

VF Mail Desktop is a Tauri app that wraps the existing web UI in a native
shell, adds a real filesystem-backed Files section, and gates the mailbox
behind a heavy-security vault-unlock ceremony.

Nothing about it phones home. The only outbound traffic goes to the user's
own mail server (their choice) and (optionally) the signed auto-updater.

## Layout

```
vfmail-desktop/
├── dist/                       Frontend (HTML/CSS/JS — shared with web build)
│   ├── index.html              Now wires vault-shell + native adapter
│   ├── app.js / app.css        Same code that runs on inbox.vfempire.com
│   ├── vf-ui.js                Shared UI primitives (dot-rail, tooltips)
│   ├── vault-shell.js          Vault-lock hero screen (mailbox-themed)
│   ├── vault-shell.css         Its styles
│   └── vf-files-native.js      Client adapter: routes Files ops to Rust
│                               when window.__TAURI__ is present; no-op
│                               in the web build so demos still work.
├── src-tauri/
│   ├── tauri.conf.json         Window / bundle / capability config
│   ├── Cargo.toml              Rust deps (rusqlite, argon2, xchacha20poly1305, …)
│   ├── build.rs
│   ├── capabilities/
│   │   └── default.json        Filesystem allowlist (only ~/VFMail/**)
│   └── src/
│       ├── main.rs             tiny entry
│       ├── lib.rs              Tauri command handlers
│       ├── vault.rs            Vault create/unlock lifecycle
│       ├── crypto.rs           Argon2id KDF + XChaCha20-Poly1305 wrap
│       ├── meta.rs             SQLite metadata (folders / files / bin / versions)
│       └── fsops.rs            Real fs::rename / fs::copy / fs::create_dir …
├── icons/                      App icons (add real ones before shipping)
└── README.md                   This file
```

## Vault layout on disk

Everything lives under a single vault directory. Default: `~/VFMail/`,
user-picked at first launch.

```
~/VFMail/
├── vault.json                  KDF params + wrapped master key
├── index.db                    SQLite metadata (WAL mode)
├── files/                      user-visible folder tree, mirrored 1:1
│   ├── Contracts/
│   │   └── NDA VF Empire.pdf   real file, real path
│   └── Invoices/2026/
├── blobs/                      content-addressed store, hard-linked from files/
│   └── ab/cd/abcd1234…
├── bin/                        soft-deleted, restorable
├── previews/                   thumbnails
└── mail-cache/                 local copy of mail for offline
```

## Security posture

- **Password → KEK**: Argon2id, 64 MiB memory, 3 iterations, 4 lanes,
  16-byte salt (industry-standard sovereign-grade).
- **Master key wrap**: XChaCha20-Poly1305 (24-byte nonce, AEAD).
- **Bytes at rest**: file bytes live under `blobs/` as-is; the metadata DB
  (SQLite) is currently plaintext — v1.1 swaps to SQLCipher.
- **Bytes in flight**: only to the user's own mail server.
- **Filesystem allowlist**: capabilities/default.json restricts fs access
  to `$HOME/VFMail/**` and `$APPDATA/VFMail/**` — the app cannot read the
  rest of the user's disk even if compromised.
- **Zero telemetry**: no analytics, no crash reporter, no third-party fonts.
- **Firewall mode** (milestone 4): user-verifiable outbound whitelist —
  blocks every socket except the declared mail server and the auto-update
  endpoint.

## Build

You need Rust and the Tauri v2 CLI. This VM lacks the system libraries
required for a full build, so build on the beast, the German PC, or a
CI runner.

### Windows (native, easiest)

```powershell
# on the German PC:
winget install Rustlang.Rustup
rustup default stable
cargo install tauri-cli@2 --locked

cd vfmail-desktop
cargo tauri build
# → src-tauri/target/release/bundle/nsis/VF Mail_0.1.0_x64-setup.exe
# → src-tauri/target/release/bundle/msi/VF Mail_0.1.0_x64_en-US.msi
```

### Linux (native, for the beast)

```bash
sudo apt-get install -y \
    pkg-config libwebkit2gtk-4.1-dev \
    libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev libsoup-3.0-dev libssl-dev

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
cargo install tauri-cli@2 --locked

cd vfmail-desktop
cargo tauri build
# → src-tauri/target/release/bundle/appimage/VF Mail_0.1.0_amd64.AppImage
# → src-tauri/target/release/bundle/deb/vf-mail_0.1.0_amd64.deb
```

### Cross-compile Linux → Windows

```bash
sudo apt-get install -y mingw-w64
rustup target add x86_64-pc-windows-gnu
cargo tauri build --target x86_64-pc-windows-gnu
```

### macOS

Build on a Mac. Standard Xcode command-line tools + rustup + tauri-cli.
Codesign with an Apple Developer ID for distribution outside the App Store.

## Verifying the Rust core in isolation

The web+desktop VM used to bootstrap this repo doesn't have the system
libraries Tauri needs, so `cargo tauri build` will fail there. To at
least prove the Rust core compiles clean, we ship a lite check crate:

```bash
cd src-tauri/core-check
cargo check   # exits 0 on this build — vault/crypto/meta/fsops all typecheck
```

## Milestone status

- [x] **M1** — Tauri scaffold, vault-lock hero, filesystem-backed Files
- [ ] **M2** — VF↔VF encrypted mail (age + Ed25519, `/.well-known/vfmail-keys/`)
- [ ] **M3** — Vault sync UI (Syncthing / NAS mount)
- [ ] **M4** — Signed installers + Tauri auto-updater
- [ ] **M5** — Mac + Linux + store submissions
