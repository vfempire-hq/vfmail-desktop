// Vault — the sovereign root of a user's mail + files.
// Lives on the user's own disk. Everything else (metadata, blobs,
// mail cache) hangs off this root.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use zeroize::Zeroize;

use crate::crypto;

/// The vault root on disk.
///
/// Layout:
///   <root>/
///     vault.json         plaintext manifest (version + created_at + kdf params)
///     master.enc         master key wrapped by password KDF
///     index.db           SQLite metadata (folders / files / bin / versions)
///     files/             the real user-visible folder tree lives here
///     blobs/aa/bb/…      content-addressed store, hard-linked from files/
///     bin/               soft-deleted (restorable)
///     previews/          thumbnails
///     mail-cache/        local copy of mail for offline
#[derive(Clone)]
pub struct Vault {
    pub root: PathBuf,
    pub created_at: i64,
    pub master_key: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
pub struct KdfParams {
    pub algo: String,       // "argon2id"
    pub salt_b64: String,   // 16 bytes
    pub mem_kib: u32,
    pub iter: u32,
    pub parallel: u32,
}

#[derive(Serialize, Deserialize)]
pub struct WrappedMaster {
    pub algo: String,       // "xchacha20poly1305"
    pub nonce_b64: String,
    pub ct_b64: String,
}

#[derive(Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub created_at: i64,
    pub kdf: KdfParams,
    pub master_wrap: WrappedMaster,
}

impl Vault {
    pub fn create(root: PathBuf, password: &str) -> Result<Self> {
        if root.exists() {
            let manifest = root.join("vault.json");
            if manifest.exists() {
                bail!("A vault already exists at {}. Unlock it instead.", root.display());
            }
        }
        fs::create_dir_all(&root).context("create vault root")?;
        for sub in ["files", "blobs", "bin", "previews", "mail-cache"] {
            fs::create_dir_all(root.join(sub))?;
        }

        // generate master key
        let mut master_key = vec![0u8; 32];
        crypto::rand_fill(&mut master_key);

        // derive KEK from password
        let (kdf, kek) = crypto::derive_kek(password)?;
        let wrapped = crypto::wrap_key(&kek, &master_key)?;

        let created_at = now_ts();
        let manifest = Manifest {
            version: 1,
            created_at,
            kdf,
            master_wrap: wrapped,
        };
        fs::write(root.join("vault.json"), serde_json::to_vec_pretty(&manifest)?)?;

        // touch the SQLite metadata db so schema is present
        crate::meta::init_db(&root)?;

        let v = Vault {
            root,
            created_at,
            master_key,
        };
        Ok(v)
    }

    pub fn unlock(root: PathBuf, password: &str) -> Result<Self> {
        let manifest_path = root.join("vault.json");
        if !manifest_path.exists() {
            bail!("No vault at {}.", root.display());
        }
        let raw = fs::read(&manifest_path)?;
        let manifest: Manifest = serde_json::from_slice(&raw)?;

        let kek = crypto::derive_kek_with(&manifest.kdf, password)?;
        let master_key = crypto::unwrap_key(&kek, &manifest.master_wrap)?;
        Ok(Vault {
            root,
            created_at: manifest.created_at,
            master_key,
        })
    }

    pub fn files_root(&self) -> PathBuf {
        self.root.join("files")
    }
    pub fn blobs_root(&self) -> PathBuf {
        self.root.join("blobs")
    }
    pub fn bin_root(&self) -> PathBuf {
        self.root.join("bin")
    }
    pub fn db_path(&self) -> PathBuf {
        self.root.join("index.db")
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        self.master_key.zeroize();
    }
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
