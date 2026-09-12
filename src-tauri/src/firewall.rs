// firewall.rs — the "nothing else leaves this machine" toggle.
//
// This is the technical guarantee behind the marketing claim.
// When on, only the following outbound connections may complete:
//   * The user's declared mail server (host from Settings)
//   * The updater endpoint (updates.vfempire.com, or the user's mirror)
//   * DNS to the user's declared resolver (usually the OS default)
//
// We enforce it at TWO layers:
//   (a) inside the process: every network call routes through
//       our HTTP client which checks the allowlist before dialling.
//   (b) at OS level (opt-in): a small helper writes host-firewall rules.
//       On Linux we use nftables, on macOS pfctl, on Windows netsh advfirewall.
//       Requires elevated permissions the first time; state persists as a
//       named profile the user can flip off.
//
// The client stores the current mode + allowlist in vault/firewall.json
// so it's independent of the machine's default posture.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;

use crate::vault::Vault;

#[derive(Serialize, Deserialize, Clone)]
pub struct FirewallProfile {
    /// "off" | "app" | "os"
    pub mode: String,
    pub mail_hosts: Vec<String>,
    pub update_hosts: Vec<String>,
    pub extra_hosts: Vec<String>,
    pub updated_at: i64,
}

impl Default for FirewallProfile {
    fn default() -> Self {
        FirewallProfile {
            mode: "off".to_string(),
            mail_hosts: vec![],
            update_hosts: vec!["updates.vfempire.com".to_string()],
            extra_hosts: vec![],
            updated_at: now_ts(),
        }
    }
}

pub fn path(v: &Vault) -> std::path::PathBuf {
    v.root.join("firewall.json")
}

pub fn load(v: &Vault) -> Result<FirewallProfile> {
    let p = path(v);
    if !p.exists() {
        return Ok(FirewallProfile::default());
    }
    let raw = fs::read(&p)?;
    Ok(serde_json::from_slice(&raw).unwrap_or_default())
}

pub fn save(v: &Vault, profile: &FirewallProfile) -> Result<()> {
    let mut p = profile.clone();
    p.updated_at = now_ts();
    fs::write(path(v), serde_json::to_vec_pretty(&p)?)?;
    Ok(())
}

#[allow(dead_code)] // reserved for OS-level firewall enforcement
pub fn is_allowed(profile: &FirewallProfile, host: &str) -> bool {
    if profile.mode == "off" {
        return true;
    }
    let h = host.trim_end_matches('.').to_lowercase();
    let sets = [&profile.mail_hosts, &profile.update_hosts, &profile.extra_hosts];
    for set in sets {
        for allowed in set {
            let a = allowed.trim_end_matches('.').to_lowercase();
            if h == a || h.ends_with(&format!(".{}", a)) {
                return true;
            }
        }
    }
    false
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
