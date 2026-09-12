// VF Mail — Sovereign Desktop
// =============================================================
// The Rust core exposes commands to the WebView that do real
// filesystem work on the user's own hardware. No third party,
// no cloud, no telemetry. The web frontend calls these via
// window.__TAURI__.core.invoke("...").

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

mod vault;
mod fsops;
mod meta;
mod crypto;
mod identity;
mod keydir;
mod mail_crypto;
mod channel;
mod sync;
mod firewall;
mod updater_endpoint;

// ---- app state ----
pub struct AppState {
    pub vault: Mutex<Option<vault::Vault>>,
    pub identity: Mutex<Option<identity::Identity>>,
}

// ==================================================================
// Vault lifecycle
// ==================================================================

#[tauri::command]
async fn vault_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let v = state.vault.lock().unwrap();
    Ok(match &*v {
        Some(vault) => serde_json::json!({
            "unlocked": true,
            "path": vault.root.to_string_lossy(),
            "created_at": vault.created_at,
        }),
        None => serde_json::json!({ "unlocked": false }),
    })
}

#[tauri::command]
async fn vault_default_path() -> Result<String, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join("VFMail");
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn vault_create(
    path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&path);
    let v = vault::Vault::create(root, &password).map_err(|e| e.to_string())?;
    let info = serde_json::json!({
        "path": v.root.to_string_lossy(),
        "created_at": v.created_at,
    });
    *state.vault.lock().unwrap() = Some(v);
    Ok(info)
}

#[tauri::command]
async fn vault_unlock(
    path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let v = vault::Vault::unlock(PathBuf::from(&path), &password).map_err(|e| e.to_string())?;
    let info = serde_json::json!({
        "path": v.root.to_string_lossy(),
        "created_at": v.created_at,
    });
    *state.vault.lock().unwrap() = Some(v);
    Ok(info)
}

#[tauri::command]
async fn vault_lock(state: State<'_, AppState>) -> Result<(), String> {
    *state.vault.lock().unwrap() = None;
    Ok(())
}

// ---- Mail account creds (stored inside the vault dir) ----
fn mail_creds_path(state: &State<'_, AppState>) -> PathBuf {
    if let Some(v) = state.vault.lock().unwrap().as_ref() {
        return v.root.join("mail.creds.json");
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join("VFMail").join("mail.creds.json")
}
fn diag(msg: &str) {
    let p = dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join("VFMail").join("mail.diag.log");
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}
#[tauri::command]
async fn mail_get_creds(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let p = mail_creds_path(&state);
    diag(&format!("mail_get_creds: checking {}", p.display()));
    if !p.exists() {
        diag("mail_get_creds: file does not exist");
        return Ok(None);
    }
    let bytes = std::fs::read(&p).map_err(|e| { diag(&format!("read err: {}", e)); e.to_string() })?;
    diag(&format!("mail_get_creds: read {} bytes", bytes.len()));
    let val: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| { diag(&format!("json err: {}", e)); e.to_string() })?;
    let ok = val.get("address").and_then(|v| v.as_str()).is_some() && val.get("password").and_then(|v| v.as_str()).is_some();
    diag(&format!("mail_get_creds: parsed ok={}", ok));
    Ok(Some(val))
}

#[tauri::command]
async fn mail_set_creds(address: String, password: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = mail_creds_path(&state);
    diag(&format!("mail_set_creds: writing {}", p.display()));
    if let Some(parent) = p.parent() { let _ = std::fs::create_dir_all(parent); }
    let val = serde_json::json!({ "address": address, "password": password });
    std::fs::write(&p, serde_json::to_vec_pretty(&val).map_err(|e| e.to_string())?)
        .map_err(|e| { diag(&format!("write err: {}", e)); e.to_string() })
}

// ==================================================================
// Filesystem commands (real folders + files on disk)
// ==================================================================

#[derive(Serialize)]
struct FolderRow {
    id: String,
    name: String,
    parent_id: Option<String>,
    created_at: i64,
    item_count: i64,
}

#[derive(Serialize)]
struct FileRow {
    id: String,
    name: String,
    display_name: Option<String>,
    folder_id: Option<String>,
    size: u64,
    mime: Option<String>,
    source_message_id: Option<String>,
    color_tag: Option<String>,
    notes: Option<String>,
    starred: bool,
    created_at: i64,
    deleted_at: Option<i64>,
}

fn vault_or_err(state: &State<'_, AppState>) -> Result<vault::Vault, String> {
    state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())
}

#[tauri::command]
async fn fs_list_folders(state: State<'_, AppState>) -> Result<Vec<FolderRow>, String> {
    let v = vault_or_err(&state)?;
    meta::list_folders(&v).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_list_files(
    folder_id: Option<String>,
    binned: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<FileRow>, String> {
    let v = vault_or_err(&state)?;
    meta::list_files(&v, folder_id.as_deref(), binned.unwrap_or(false)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_create_folder(
    name: String,
    parent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<FolderRow, String> {
    let v = vault_or_err(&state)?;
    fsops::create_folder(&v, &name, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_rename_folder(
    id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    fsops::rename_folder(&v, &id, &new_name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_delete_folder(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    fsops::delete_folder_to_bin(&v, &id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_move_file(
    id: String,
    folder_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    fsops::move_file(&v, &id, folder_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_rename_file(
    id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    fsops::rename_file(&v, &id, &new_name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_copy_file(
    id: String,
    folder_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<FileRow, String> {
    let v = vault_or_err(&state)?;
    fsops::copy_file(&v, &id, folder_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_delete_file(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    fsops::delete_file_to_bin(&v, &id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_restore_file(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    fsops::restore_from_bin(&v, &id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_empty_bin(state: State<'_, AppState>) -> Result<u32, String> {
    let v = vault_or_err(&state)?;
    fsops::empty_bin(&v).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_upload_bytes(
    name: String,
    folder_id: Option<String>,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<FileRow, String> {
    let v = vault_or_err(&state)?;
    fsops::ingest_bytes(&v, &name, folder_id.as_deref(), &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_star(id: String, on: bool, state: State<'_, AppState>) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    meta::set_star(&v, &id, on).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_set_color(id: String, color: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    meta::set_color(&v, &id, color.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_set_notes(id: String, notes: String, state: State<'_, AppState>) -> Result<(), String> {
    let v = vault_or_err(&state)?;
    meta::set_notes(&v, &id, &notes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_stats(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let v = vault_or_err(&state)?;
    meta::stats(&v).map_err(|e| e.to_string())
}

// ==================================================================
// M2 — encrypted mail
// ==================================================================

#[tauri::command]
async fn identity_ensure(
    email: String,
    host: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let existing = identity::Identity::load(&v).map_err(|e| e.to_string())?;
    let id = match existing {
        Some(i) => i,
        None => identity::Identity::create(&v, &email, &host).map_err(|e| e.to_string())?,
    };
    let info = serde_json::json!({
        "email": id.email,
        "created_at": id.created_at,
        "age_recipient": id.public.age_recipient,
        "signing_pub_b64": id.public.signing_pub_b64,
        "well_known_url": id.well_known_url(),
    });
    *state.identity.lock().unwrap() = Some(id);
    Ok(info)
}

#[tauri::command]
async fn identity_public_json(state: State<'_, AppState>) -> Result<String, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let path = v.root.join("identity.pub.json");
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn keydir_lookup(
    email: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let result = keydir::lookup(&v, &email).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn mail_seal(
    recipients: Vec<serde_json::Value>,
    plaintext: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "identity-missing".to_string())?;
    let mut recs = Vec::new();
    for r in recipients {
        let email = r["email"].as_str().unwrap_or_default().to_string();
        let age_recipient = r["age_recipient"].as_str().unwrap_or_default().to_string();
        let signing_pub_b64 = r["signing_pub_b64"].as_str().unwrap_or_default().to_string();
        if age_recipient.is_empty() {
            return Err(format!("recipient {email} has no age key"));
        }
        recs.push(mail_crypto::RecipientKey { email, age_recipient, signing_pub_b64 });
    }
    let sealed =
        mail_crypto::seal(&identity, &recs, plaintext.as_bytes()).map_err(|e| e.to_string())?;
    mail_crypto::to_mime_body(&sealed).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mail_open(
    mime_body: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "identity-missing".to_string())?;
    let payload = mail_crypto::from_mime_body(&mime_body).map_err(|e| e.to_string())?;
    let opened = mail_crypto::open(&identity, &payload).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "plaintext": String::from_utf8_lossy(&opened.plaintext),
        "sender": opened.sender,
        "signature_verified": opened.signature_verified,
    }))
}

// ==================================================================
// M3 — vault sync
// ==================================================================

#[tauri::command]
async fn sync_detect(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let report = sync::detect_providers(&v.root).map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(report).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn sync_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let s = sync::status(&v).map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(s).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn sync_move_vault(
    target: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let dst = std::path::PathBuf::from(&target);
    let new_path = sync::move_vault(&v.root, &dst).map_err(|e| e.to_string())?;
    // clear the in-memory vault — the caller must re-unlock at the new path.
    *state.vault.lock().unwrap() = None;
    *state.identity.lock().unwrap() = None;
    Ok(serde_json::json!({
        "moved_to": new_path.to_string_lossy(),
        "reunlock_required": true,
    }))
}

#[tauri::command]
async fn sync_scan_conflicts(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let report = sync::scan_conflicts(&v).map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(report).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn sync_snapshot_db(state: State<'_, AppState>) -> Result<String, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let dst = sync::snapshot_db(&v).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

// ==================================================================
// M4 — firewall profile
// ==================================================================

#[tauri::command]
async fn firewall_get(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let profile = firewall::load(&v).map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(profile).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn firewall_set(
    mode: String,
    mail_hosts: Vec<String>,
    update_hosts: Vec<String>,
    extra_hosts: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let v = state
        .vault
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "vault-locked".to_string())?;
    let profile = firewall::FirewallProfile {
        mode,
        mail_hosts,
        update_hosts,
        extra_hosts,
        updated_at: 0,
    };
    firewall::save(&v, &profile).map_err(|e| e.to_string())
}

#[tauri::command]
async fn firewall_updater_endpoint() -> Result<String, String> {
    Ok(updater_endpoint::ENDPOINT.to_string())
}

// ==================================================================
// Runtime bootstrap
// ==================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            vault: Mutex::new(None),
            identity: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_default_path,
            vault_create,
            vault_unlock,
            vault_lock,
            mail_get_creds,
            mail_set_creds,
            fs_list_folders,
            fs_list_files,
            fs_create_folder,
            fs_rename_folder,
            fs_delete_folder,
            fs_move_file,
            fs_rename_file,
            fs_copy_file,
            fs_delete_file,
            fs_restore_file,
            fs_empty_bin,
            fs_upload_bytes,
            fs_star,
            fs_set_color,
            fs_set_notes,
            fs_stats,
            identity_ensure,
            identity_public_json,
            keydir_lookup,
            mail_seal,
            mail_open,
            channel::channel_send,
            channel::channel_pull,
            channel::channel_ack,
            sync_detect,
            sync_status,
            sync_move_vault,
            sync_scan_conflicts,
            sync_snapshot_db,
            firewall_get,
            firewall_set,
            firewall_updater_endpoint,
        ])
        .run(tauri::generate_context!())
        .expect("VF Mail failed to boot");
}
