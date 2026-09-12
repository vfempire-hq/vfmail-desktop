// sync.rs — user-owned vault synchronisation.
//
// VF never runs a sync server. The user picks a channel THEY control
// and points VF Mail at a vault location inside that channel.
// Detection is best-effort — we just report which providers we can see.
//
// Sync model:
//   • The whole vault directory (files/, blobs/, bin/, index.db,
//     identity.enc, vault.json …) lives inside the sync folder.
//   • On startup we snapshot index.db → backups/index-<epoch>.db.
//   • A conflict scanner looks for sibling files ending in
//     ".sync-conflict-*" (which most providers create) and quarantines
//     them under conflicts/.
//   • Auto-updater / mail sync will (M4+) hold a per-machine lockfile
//     under vault/locks/<hostname>.lock so two devices don't write
//     concurrently.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::vault::Vault;

#[derive(Serialize, Clone)]
pub struct SyncProvider {
    pub key: String,          // "syncthing" | "icloud" | "dropbox" | "onedrive" | "gdrive" | "custom"
    pub label: String,        // "Syncthing"
    pub description: String,  // "Peer-to-peer, no third-party servers"
    pub installed: bool,
    pub suggested_path: Option<String>,
    pub trust_score: u8,      // 0..=100 — how sovereign this option is
}

#[derive(Serialize)]
pub struct SyncReport {
    pub providers: Vec<SyncProvider>,
    pub current_vault: String,
    pub in_synced_folder: Option<String>, // provider key if vault currently lives inside one
}

pub fn detect_providers(current_vault: &Path) -> Result<SyncReport> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut out: Vec<SyncProvider> = Vec::new();

    // Syncthing — peer-to-peer, best sovereign choice.
    let syncthing_paths = [
        home.join(".config").join("syncthing"),
        home.join(".local").join("state").join("syncthing"),
        home.join("Library").join("Application Support").join("Syncthing"),
        home.join("AppData").join("Local").join("Syncthing"),
    ];
    let sync_installed = syncthing_paths.iter().any(|p| p.exists());
    let sync_default = home.join("Sync").join("VFMail");
    out.push(SyncProvider {
        key: "syncthing".into(),
        label: "Syncthing".into(),
        description: "Peer-to-peer sync between your own devices. No third party sees your bytes. Recommended.".into(),
        installed: sync_installed,
        suggested_path: Some(sync_default.to_string_lossy().to_string()),
        trust_score: 100,
    });

    // iCloud Drive — Apple sees the encrypted blobs but not the vault master key.
    let icloud = home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs");
    out.push(SyncProvider {
        key: "icloud".into(),
        label: "iCloud Drive".into(),
        description: "Apple stores your (encrypted) vault. Apple can compel disclosure of the encrypted blob. Convenient across Mac/iOS.".into(),
        installed: icloud.exists(),
        suggested_path: Some(icloud.join("VF Mail").to_string_lossy().to_string()),
        trust_score: 55,
    });

    // Dropbox
    for name in ["Dropbox", "Dropbox (Personal)"] {
        let p = home.join(name);
        if p.exists() {
            out.push(SyncProvider {
                key: "dropbox".into(),
                label: "Dropbox".into(),
                description: "Encrypted vault stored at Dropbox. They see the encrypted bytes only.".into(),
                installed: true,
                suggested_path: Some(p.join("VF Mail").to_string_lossy().to_string()),
                trust_score: 40,
            });
            break;
        }
    }

    // OneDrive
    for name in ["OneDrive", "OneDrive - Personal"] {
        let p = home.join(name);
        if p.exists() {
            out.push(SyncProvider {
                key: "onedrive".into(),
                label: "OneDrive".into(),
                description: "Microsoft-hosted sync. Encrypted vault only, but Microsoft sees the file tree.".into(),
                installed: true,
                suggested_path: Some(p.join("VF Mail").to_string_lossy().to_string()),
                trust_score: 35,
            });
            break;
        }
    }

    // Google Drive
    for name in ["Google Drive", "GoogleDrive"] {
        let p = home.join(name);
        if p.exists() {
            out.push(SyncProvider {
                key: "gdrive".into(),
                label: "Google Drive".into(),
                description: "Encrypted vault stored at Google. They see the encrypted bytes.".into(),
                installed: true,
                suggested_path: Some(p.join("VF Mail").to_string_lossy().to_string()),
                trust_score: 25,
            });
            break;
        }
    }

    // Custom path — always an option.
    out.push(SyncProvider {
        key: "custom".into(),
        label: "Custom folder".into(),
        description: "Any folder you like — NAS mount, external SSD, Nextcloud, WebDAV…".into(),
        installed: true,
        suggested_path: None,
        trust_score: 80,
    });

    let in_sync = which_provider_contains(current_vault, &out);

    Ok(SyncReport {
        providers: out,
        current_vault: current_vault.to_string_lossy().to_string(),
        in_synced_folder: in_sync,
    })
}

fn which_provider_contains(vault: &Path, providers: &[SyncProvider]) -> Option<String> {
    for p in providers {
        if let Some(sp) = &p.suggested_path {
            let path = Path::new(sp);
            if vault.starts_with(path) {
                return Some(p.key.clone());
            }
        }
    }
    None
}

/// Move an entire vault directory tree from `source` to `target`.
/// Returns the new path. Preserves relative structure; skips the WAL /
/// SHM sidecars because those are rebuilt on reopen.
pub fn move_vault(source: &Path, target: &Path) -> Result<PathBuf> {
    if target.exists() && target.read_dir()?.next().is_some() {
        return Err(anyhow!(
            "Target folder {} is not empty — pick an empty folder or delete its contents first.",
            target.display()
        ));
    }
    fs::create_dir_all(target).context("mkdir target")?;
    copy_dir_recursive(source, target)?;
    // strip WAL/SHM leftovers at target — SQLite will rebuild.
    let _ = fs::remove_file(target.join("index.db-wal"));
    let _ = fs::remove_file(target.join("index.db-shm"));
    Ok(target.to_path_buf())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    for entry in fs::read_dir(src)? {
        let e = entry?;
        let ty = e.file_type()?;
        let name = e.file_name();
        let from = e.path();
        let to = dst.join(&name);
        if ty.is_dir() {
            fs::create_dir_all(&to)?;
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_symlink() {
            // preserve as best-effort: skip, don't fail
        } else {
            fs::copy(&from, &to).with_context(|| format!("copy {}", from.display()))?;
        }
    }
    Ok(())
}

/// Snapshot index.db before startup mutations. Kept under
/// <vault>/backups/index-<epoch>.db and rotated (keep last 10).
pub fn snapshot_db(v: &Vault) -> Result<PathBuf> {
    let src = v.db_path();
    if !src.exists() {
        return Ok(src);
    }
    let dir = v.root.join("backups");
    fs::create_dir_all(&dir)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dst = dir.join(format!("index-{}.db", ts));
    fs::copy(&src, &dst).context("snapshot db")?;
    rotate_backups(&dir, 10);
    Ok(dst)
}

fn rotate_backups(dir: &Path, keep: usize) {
    if let Ok(entries) = fs::read_dir(dir) {
        let mut all: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        all.sort();
        while all.len() > keep {
            let _ = fs::remove_file(all.remove(0));
        }
    }
}

#[derive(Serialize)]
pub struct ConflictReport {
    pub count: u32,
    pub items: Vec<String>,
}

/// Scan for sync-conflict sidecars that most providers leave behind
/// (Syncthing appends ".sync-conflict-…", Dropbox appends "(conflicted)",
/// OneDrive prefixes with the hostname).
pub fn scan_conflicts(v: &Vault) -> Result<ConflictReport> {
    let mut items = Vec::new();
    walk(&v.root, &mut items)?;
    let conflicts_dir = v.root.join("conflicts");
    for path in &items {
        let name = Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        fs::create_dir_all(&conflicts_dir).ok();
        let quarantined = conflicts_dir.join(name);
        let _ = fs::rename(path, quarantined);
    }
    Ok(ConflictReport {
        count: items.len() as u32,
        items,
    })
}

fn walk(dir: &Path, out: &mut Vec<String>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let e = entry?;
        let ty = e.file_type()?;
        let name = e.file_name().to_string_lossy().to_string();
        // Skip our own conflicts/ folder — we DON'T want a loop.
        if name == "conflicts" || name == "backups" {
            continue;
        }
        if ty.is_dir() {
            walk(&e.path(), out)?;
        } else {
            if name.contains(".sync-conflict-")
                || name.contains(" (conflicted copy ")
                || name.contains("_conflict-")
            {
                out.push(e.path().to_string_lossy().to_string());
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct SyncStatus {
    pub in_synced_folder: Option<String>, // provider key
    pub last_modified: i64,               // vault mtime
    pub conflict_count: u32,
    pub other_hosts: Vec<String>,
}

pub fn status(v: &Vault) -> Result<SyncStatus> {
    let providers = detect_providers(&v.root)?;
    let mtime = fs::metadata(v.db_path().parent().unwrap_or(&v.root))
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let conflicts_dir = v.root.join("conflicts");
    let conflict_count = fs::read_dir(&conflicts_dir)
        .map(|d| d.count() as u32)
        .unwrap_or(0);
    // Other hosts that have written to this vault (M4 will populate this).
    let locks_dir = v.root.join("locks");
    let mut other_hosts = Vec::new();
    if let Ok(d) = fs::read_dir(&locks_dir) {
        for entry in d.flatten() {
            if let Some(s) = entry.file_name().to_str() {
                other_hosts.push(s.trim_end_matches(".lock").to_string());
            }
        }
    }
    Ok(SyncStatus {
        in_synced_folder: providers.in_synced_folder,
        last_modified: mtime,
        conflict_count,
        other_hosts,
    })
}
