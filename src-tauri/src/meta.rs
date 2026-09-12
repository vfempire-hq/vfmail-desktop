// meta.rs — SQLite metadata store.
// Folder tree, file records, bin, stars/colors/notes, versions.
//
// The DB is a plain SQLite file on disk in the vault. It's not
// encrypted at rest yet — v1.1 will add SQLCipher. Blobs on disk
// are already content-addressed and dedup by hash.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;
use std::path::Path;

use crate::vault::Vault;
use crate::{FileRow, FolderRow};

fn conn(v: &Vault) -> Result<Connection> {
    let c = Connection::open(v.db_path())?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "foreign_keys", true)?;
    Ok(c)
}

pub fn init_db(root: &Path) -> Result<()> {
    let c = Connection::open(root.join("index.db"))?;
    c.execute_batch(SCHEMA)?;
    Ok(())
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    disk_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    blob_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT,
    folder_id TEXT,
    size INTEGER NOT NULL,
    mime TEXT,
    source_message_id TEXT,
    source_attachment_name TEXT,
    color_tag TEXT,
    notes TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_blob   ON files(blob_hash);
CREATE INDEX IF NOT EXISTS idx_files_bin    ON files(deleted_at);

CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_items (
    collection_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    PRIMARY KEY (collection_id, file_id)
);

CREATE TABLE IF NOT EXISTS file_versions (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    blob_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"#;

pub fn list_folders(v: &Vault) -> Result<Vec<FolderRow>> {
    let c = conn(v)?;
    let mut s = c.prepare(
        "SELECT f.id, f.name, f.parent_id, f.created_at,
                (SELECT COUNT(*) FROM files WHERE folder_id = f.id AND deleted_at IS NULL) +
                (SELECT COUNT(*) FROM folders WHERE parent_id = f.id) AS n
         FROM folders f",
    )?;
    let rows = s.query_map([], |r| {
        Ok(FolderRow {
            id: r.get(0)?,
            name: r.get(1)?,
            parent_id: r.get(2)?,
            created_at: r.get(3)?,
            item_count: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn list_files(v: &Vault, folder_id: Option<&str>, binned: bool) -> Result<Vec<FileRow>> {
    let c = conn(v)?;
    let (sql, do_fid): (&str, bool) = if binned {
        ("SELECT id, name, display_name, folder_id, size, mime, source_message_id, color_tag, notes, starred, created_at, deleted_at FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC", false)
    } else if folder_id.is_some() {
        ("SELECT id, name, display_name, folder_id, size, mime, source_message_id, color_tag, notes, starred, created_at, deleted_at FROM files WHERE deleted_at IS NULL AND folder_id = ?1 ORDER BY created_at DESC", true)
    } else {
        ("SELECT id, name, display_name, folder_id, size, mime, source_message_id, color_tag, notes, starred, created_at, deleted_at FROM files WHERE deleted_at IS NULL AND folder_id IS NULL ORDER BY created_at DESC", false)
    };
    let mut s = c.prepare(sql)?;
    let mapper = |r: &rusqlite::Row| {
        Ok(FileRow {
            id: r.get(0)?,
            name: r.get(1)?,
            display_name: r.get(2)?,
            folder_id: r.get(3)?,
            size: r.get::<_, i64>(4)? as u64,
            mime: r.get(5)?,
            source_message_id: r.get(6)?,
            color_tag: r.get(7)?,
            notes: r.get(8)?,
            starred: r.get::<_, i32>(9)? != 0,
            created_at: r.get(10)?,
            deleted_at: r.get(11)?,
        })
    };
    let rows: Vec<FileRow> = if do_fid {
        s.query_map(params![folder_id.unwrap()], mapper)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        s.query_map([], mapper)?.collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

pub fn set_star(v: &Vault, id: &str, on: bool) -> Result<()> {
    conn(v)?.execute(
        "UPDATE files SET starred = ?1 WHERE id = ?2",
        params![if on { 1 } else { 0 }, id],
    )?;
    Ok(())
}
pub fn set_color(v: &Vault, id: &str, color: Option<&str>) -> Result<()> {
    conn(v)?.execute(
        "UPDATE files SET color_tag = ?1 WHERE id = ?2",
        params![color, id],
    )?;
    Ok(())
}
pub fn set_notes(v: &Vault, id: &str, notes: &str) -> Result<()> {
    conn(v)?.execute(
        "UPDATE files SET notes = ?1 WHERE id = ?2",
        params![notes, id],
    )?;
    Ok(())
}

pub fn stats(v: &Vault) -> Result<serde_json::Value> {
    let c = conn(v)?;
    let total_files: i64 =
        c.query_row("SELECT COUNT(*) FROM files WHERE deleted_at IS NULL", [], |r| r.get(0))?;
    let total_size: i64 = c
        .query_row(
            "SELECT COALESCE(SUM(size),0) FROM files WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let binned: i64 =
        c.query_row("SELECT COUNT(*) FROM files WHERE deleted_at IS NOT NULL", [], |r| r.get(0))?;
    let folders: i64 = c.query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0))?;
    Ok(json!({
        "files": total_files,
        "bytes": total_size,
        "binned": binned,
        "folders": folders,
    }))
}
