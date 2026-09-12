// Compile the Rust core WITHOUT tauri sys deps so we can prove the logic
// is syntactically + type-clean on this VM. Not shipped — dev-only sanity.

use serde::Serialize;

#[derive(Serialize)]
pub struct FolderRow {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub created_at: i64,
    pub item_count: i64,
}

#[derive(Serialize)]
pub struct FileRow {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub folder_id: Option<String>,
    pub size: u64,
    pub mime: Option<String>,
    pub source_message_id: Option<String>,
    pub color_tag: Option<String>,
    pub notes: Option<String>,
    pub starred: bool,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
}

pub mod vault { include!("../../src/vault.rs"); }
pub mod crypto { include!("../../src/crypto.rs"); }
pub mod meta { include!("../../src/meta.rs"); }
pub mod fsops { include!("../../src/fsops.rs"); }
pub mod identity { include!("../../src/identity.rs"); }
pub mod keydir { include!("../../src/keydir.rs"); }
pub mod mail_crypto { include!("../../src/mail_crypto.rs"); }
pub mod sync { include!("../../src/sync.rs"); }
pub mod firewall { include!("../../src/firewall.rs"); }
pub mod updater_endpoint { include!("../../src/updater_endpoint.rs"); }
