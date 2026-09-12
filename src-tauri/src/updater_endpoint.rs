// updater_endpoint.rs — describes the update manifest Tauri fetches.
//
// The manifest lives at https://updates.vfempire.com/vfmail/{{target}}/{{arch}}/{{current_version}}
// and is a signed JSON:
//
//   {
//     "version": "0.2.0",
//     "notes": "M2 encrypted mail + Files improvements",
//     "pub_date": "2026-11-01T12:00:00Z",
//     "platforms": {
//       "windows-x86_64": {
//         "signature": "<Tauri updater signature>",
//         "url": "https://updates.vfempire.com/vfmail/0.2.0/VF_Mail_0.2.0_x64-setup.exe"
//       },
//       "darwin-aarch64": { … },
//       "linux-x86_64":   { … }
//     }
//   }
//
// Tauri v2 verifies the signature against the public key embedded in
// tauri.conf.json. Rotating keys means a manual reinstall.
//
// This file is documentation-only; the actual updater logic ships with
// tauri-plugin-updater.

pub const ENDPOINT: &str =
    "https://updates.vfempire.com/vfmail/{{target}}/{{arch}}/{{current_version}}";
#[allow(dead_code)] // stamped into manifests when the updater publishes them
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
