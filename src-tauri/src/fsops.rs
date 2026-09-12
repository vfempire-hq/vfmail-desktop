// fsops.rs — actual filesystem operations.
// Every create/rename/move/copy/delete touches a real path on the
// user's disk. Files under vault/files/ mirror what the UI shows,
// and are hard-linked from a content-addressed blob store.

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::crypto;
use crate::vault::Vault;
use crate::{FileRow, FolderRow};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn conn(v: &Vault) -> Result<Connection> {
    let c = Connection::open(v.db_path())?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "foreign_keys", true)?;
    Ok(c)
}

fn folder_disk_path(v: &Vault, parent_id: Option<&str>, name: &str) -> Result<PathBuf> {
    let mut path = v.files_root();
    if let Some(pid) = parent_id {
        let c = conn(v)?;
        let parent_disk: String =
            c.query_row("SELECT disk_path FROM folders WHERE id = ?1", params![pid], |r| r.get(0))
                .context("parent folder not found")?;
        path = v.root.join(parent_disk);
    }
    path.push(sanitise(name));
    Ok(path)
}

fn sanitise(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if "/\\<>:\"|?*\0".contains(ch) {
            out.push('_')
        } else {
            out.push(ch)
        }
    }
    out.trim().to_string()
}

pub fn create_folder(v: &Vault, name: &str, parent_id: Option<&str>) -> Result<FolderRow> {
    let disk_path = folder_disk_path(v, parent_id, name)?;
    fs::create_dir_all(&disk_path).context("mkdir")?;

    let id = format!("fd_{}", Uuid::new_v4().simple());
    let created_at = now_ts();
    let disk_rel = disk_path.strip_prefix(&v.root)?.to_string_lossy().to_string();

    let c = conn(v)?;
    c.execute(
        "INSERT INTO folders (id, name, parent_id, created_at, disk_path) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, parent_id, created_at, disk_rel],
    )?;

    Ok(FolderRow {
        id,
        name: name.to_string(),
        parent_id: parent_id.map(String::from),
        created_at,
        item_count: 0,
    })
}

pub fn rename_folder(v: &Vault, id: &str, new_name: &str) -> Result<()> {
    let c = conn(v)?;
    let (old_disk, parent_id): (String, Option<String>) = c.query_row(
        "SELECT disk_path, parent_id FROM folders WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let old_path = v.root.join(&old_disk);
    let new_path = folder_disk_path(v, parent_id.as_deref(), new_name)?;
    fs::rename(&old_path, &new_path).context("rename dir")?;
    let new_rel = new_path.strip_prefix(&v.root)?.to_string_lossy().to_string();
    c.execute(
        "UPDATE folders SET name = ?1, disk_path = ?2 WHERE id = ?3",
        params![new_name, new_rel, id],
    )?;
    // rewrite disk_path for descendants (simple prefix swap)
    let old_prefix = format!("{}/", old_disk);
    let new_prefix = format!("{}/", new_rel);
    c.execute(
        "UPDATE folders SET disk_path = REPLACE(disk_path, ?1, ?2) WHERE disk_path LIKE ?3",
        params![old_prefix, new_prefix, format!("{}%", old_prefix)],
    )?;
    Ok(())
}

pub fn delete_folder_to_bin(v: &Vault, id: &str) -> Result<()> {
    let c = conn(v)?;
    let (disk_path, name): (String, String) = c.query_row(
        "SELECT disk_path, name FROM folders WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let src = v.root.join(&disk_path);
    if !src.exists() {
        bail!("folder gone on disk");
    }
    let bin_target = v.bin_root().join(format!(
        "{}_{}",
        now_ts(),
        sanitise(&name)
    ));
    fs::rename(&src, &bin_target).context("move to bin")?;
    // mark all files in this folder as binned via SQL cascade
    c.execute(
        "UPDATE files SET deleted_at = ?1, deleted_from = folder_id
         WHERE folder_id IN (
             SELECT id FROM folders WHERE id = ?2 OR disk_path LIKE ?3
         )",
        params![now_ts(), id, format!("{}%", disk_path)],
    )?;
    c.execute(
        "DELETE FROM folders WHERE id = ?1 OR disk_path LIKE ?2",
        params![id, format!("{}%", disk_path)],
    )?;
    Ok(())
}

pub fn move_file(v: &Vault, id: &str, folder_id: Option<&str>) -> Result<()> {
    let c = conn(v)?;
    let (name, current_folder): (String, Option<String>) = c.query_row(
        "SELECT name, folder_id FROM files WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let src = file_disk_path(v, current_folder.as_deref(), &name)?;
    let dst_dir = if let Some(f) = folder_id {
        let disk: String =
            c.query_row("SELECT disk_path FROM folders WHERE id = ?1", params![f], |r| r.get(0))?;
        v.root.join(disk)
    } else {
        v.files_root()
    };
    fs::create_dir_all(&dst_dir)?;
    let dst = dst_dir.join(sanitise(&name));
    fs::rename(&src, &dst).context("move file")?;
    c.execute(
        "UPDATE files SET folder_id = ?1 WHERE id = ?2",
        params![folder_id, id],
    )?;
    Ok(())
}

pub fn rename_file(v: &Vault, id: &str, new_name: &str) -> Result<()> {
    let c = conn(v)?;
    let (name, folder): (String, Option<String>) = c.query_row(
        "SELECT name, folder_id FROM files WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let src = file_disk_path(v, folder.as_deref(), &name)?;
    let dst = src
        .parent()
        .ok_or_else(|| anyhow!("bad path"))?
        .join(sanitise(new_name));
    fs::rename(&src, &dst).context("rename file")?;
    c.execute(
        "UPDATE files SET name = ?1 WHERE id = ?2",
        params![new_name, id],
    )?;
    Ok(())
}

pub fn copy_file(v: &Vault, id: &str, folder_id: Option<&str>) -> Result<FileRow> {
    let c = conn(v)?;
    let row: (String, String, String, i64, Option<String>) = c.query_row(
        "SELECT name, blob_hash, COALESCE(mime,''), size, source_message_id
         FROM files WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let (name, blob_hash, mime, size, source) = row;
    let copy_name = format!("Copy of {}", name);
    let dst_dir = if let Some(f) = folder_id {
        let disk: String =
            c.query_row("SELECT disk_path FROM folders WHERE id = ?1", params![f], |r| r.get(0))?;
        v.root.join(disk)
    } else {
        v.files_root()
    };
    fs::create_dir_all(&dst_dir)?;
    let dst = dst_dir.join(sanitise(&copy_name));
    // hard-link if possible (same blob), else copy
    let blob_path = blob_path_of(v, &blob_hash);
    if let Err(_) = fs::hard_link(&blob_path, &dst) {
        fs::copy(&blob_path, &dst)?;
    }
    let new_id = format!("f_{}", Uuid::new_v4().simple());
    let created_at = now_ts();
    c.execute(
        "INSERT INTO files (id, blob_hash, name, folder_id, size, mime, source_message_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![new_id, blob_hash, copy_name, folder_id, size, mime, source, created_at],
    )?;
    Ok(FileRow {
        id: new_id,
        name: copy_name,
        display_name: None,
        folder_id: folder_id.map(String::from),
        size: size as u64,
        mime: if mime.is_empty() { None } else { Some(mime) },
        source_message_id: source,
        color_tag: None,
        notes: None,
        starred: false,
        created_at,
        deleted_at: None,
    })
}

pub fn delete_file_to_bin(v: &Vault, id: &str) -> Result<()> {
    let c = conn(v)?;
    let (name, folder): (String, Option<String>) = c.query_row(
        "SELECT name, folder_id FROM files WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let src = file_disk_path(v, folder.as_deref(), &name)?;
    let bin_dir = v.bin_root();
    fs::create_dir_all(&bin_dir)?;
    let dst = bin_dir.join(format!("{}_{}", now_ts(), sanitise(&name)));
    if src.exists() {
        fs::rename(&src, &dst)?;
    }
    c.execute(
        "UPDATE files SET deleted_at = ?1, deleted_from = ?2 WHERE id = ?3",
        params![now_ts(), folder, id],
    )?;
    Ok(())
}

pub fn restore_from_bin(v: &Vault, id: &str) -> Result<()> {
    let c = conn(v)?;
    let (name, deleted_from): (String, Option<String>) = c.query_row(
        "SELECT name, deleted_from FROM files WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // find the bin file that matches — just take the most recent one with matching suffix
    let bin_dir = v.bin_root();
    let mut best: Option<PathBuf> = None;
    let mut best_ts = 0i64;
    for entry in fs::read_dir(&bin_dir)? {
        let e = entry?;
        let fname = e.file_name();
        let s = fname.to_string_lossy();
        if let Some((ts_str, rest)) = s.split_once('_') {
            if rest == sanitise(&name) {
                if let Ok(ts) = ts_str.parse::<i64>() {
                    if ts > best_ts {
                        best_ts = ts;
                        best = Some(e.path());
                    }
                }
            }
        }
    }
    let dst_dir = if let Some(f) = deleted_from.as_deref() {
        let disk: String =
            c.query_row("SELECT disk_path FROM folders WHERE id = ?1", params![f], |r| r.get(0))?;
        v.root.join(disk)
    } else {
        v.files_root()
    };
    fs::create_dir_all(&dst_dir)?;
    let dst = dst_dir.join(sanitise(&name));
    if let Some(bin_path) = best {
        fs::rename(&bin_path, &dst).context("restore")?;
    }
    c.execute(
        "UPDATE files SET deleted_at = NULL, folder_id = deleted_from, deleted_from = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn empty_bin(v: &Vault) -> Result<u32> {
    let c = conn(v)?;
    let ids: Vec<String> = c
        .prepare("SELECT id FROM files WHERE deleted_at IS NOT NULL")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let bin_dir = v.bin_root();
    for entry in fs::read_dir(&bin_dir)? {
        let _ = fs::remove_file(entry?.path());
    }
    let n = ids.len() as u32;
    c.execute("DELETE FROM files WHERE deleted_at IS NOT NULL", [])?;
    Ok(n)
}

pub fn ingest_bytes(
    v: &Vault,
    name: &str,
    folder_id: Option<&str>,
    bytes: &[u8],
) -> Result<FileRow> {
    let hash = crypto::content_hash(bytes);
    let blob_path = blob_path_of(v, &hash);
    if !blob_path.exists() {
        fs::create_dir_all(blob_path.parent().unwrap())?;
        fs::write(&blob_path, bytes)?;
    }
    let dst_dir = if let Some(f) = folder_id {
        let c = conn(v)?;
        let disk: String =
            c.query_row("SELECT disk_path FROM folders WHERE id = ?1", params![f], |r| r.get(0))?;
        v.root.join(disk)
    } else {
        v.files_root()
    };
    fs::create_dir_all(&dst_dir)?;
    let dst = dst_dir.join(sanitise(name));
    if let Err(_) = fs::hard_link(&blob_path, &dst) {
        fs::copy(&blob_path, &dst)?;
    }
    let id = format!("f_{}", Uuid::new_v4().simple());
    let created_at = now_ts();
    let mime = mime_guess(&dst);
    let c = conn(v)?;
    c.execute(
        "INSERT INTO files (id, blob_hash, name, folder_id, size, mime, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, hash, name, folder_id, bytes.len() as i64, mime, created_at],
    )?;
    Ok(FileRow {
        id,
        name: name.to_string(),
        display_name: None,
        folder_id: folder_id.map(String::from),
        size: bytes.len() as u64,
        mime,
        source_message_id: None,
        color_tag: None,
        notes: None,
        starred: false,
        created_at,
        deleted_at: None,
    })
}

fn file_disk_path(v: &Vault, folder_id: Option<&str>, name: &str) -> Result<PathBuf> {
    let dir = if let Some(f) = folder_id {
        let c = conn(v)?;
        let disk: String =
            c.query_row("SELECT disk_path FROM folders WHERE id = ?1", params![f], |r| r.get(0))?;
        v.root.join(disk)
    } else {
        v.files_root()
    };
    Ok(dir.join(sanitise(name)))
}

fn blob_path_of(v: &Vault, hash: &str) -> PathBuf {
    v.blobs_root().join(&hash[0..2]).join(&hash[2..4]).join(hash)
}

fn mime_guess(p: &Path) -> Option<String> {
    let ext = p.extension().and_then(|s| s.to_str())?.to_lowercase();
    Some(
        match ext.as_str() {
            "pdf" => "application/pdf",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "mp4" => "video/mp4",
            "mov" => "video/quicktime",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "zip" => "application/zip",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "txt" | "md" => "text/plain",
            "html" | "htm" => "text/html",
            _ => "application/octet-stream",
        }
        .to_string(),
    )
}
