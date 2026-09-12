// keydir.rs — resolve another VF Mail user's public key.
//
// Given "alice@example.com", we try:
//   1. https://example.com/.well-known/vfmail-keys/alice%40example.com.json
//   2. https://mail.example.com/.well-known/vfmail-keys/alice%40example.com.json
//   3. https://example.com/.well-known/vfmail-keys/alice.json
//
// Results are cached to <vault>/keydir/<sha256>.json so we never
// re-fetch without reason and can work offline for known recipients.
//
// If none succeed, the recipient is treated as "not a VF Mail user"
// and mail goes out in clear (with a warning to the sender).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::time::Duration;

use crate::identity::PublishedKey;
use crate::vault::Vault;

const CACHE_TTL_SECS: i64 = 60 * 60 * 24; // 24h

#[derive(Serialize)]
pub struct KeyLookup {
    pub found: bool,
    pub key: Option<PublishedKey>,
    pub source: Option<String>, // which URL we resolved from
    pub cached: bool,
}

#[derive(Serialize, Deserialize)]
struct CacheEntry {
    fetched_at: i64,
    source: String,
    key: PublishedKey,
}

pub async fn lookup(v: &Vault, email: &str) -> Result<KeyLookup> {
    let cache_dir = v.root.join("keydir");
    let _ = fs::create_dir_all(&cache_dir);
    let cache_path = cache_dir.join(format!("{}.json", email_hash(email)));

    if let Ok(raw) = fs::read(&cache_path) {
        if let Ok(entry) = serde_json::from_slice::<CacheEntry>(&raw) {
            if now_ts() - entry.fetched_at < CACHE_TTL_SECS {
                return Ok(KeyLookup {
                    found: true,
                    key: Some(entry.key),
                    source: Some(entry.source),
                    cached: true,
                });
            }
        }
    }

    let domain = email
        .split('@')
        .nth(1)
        .ok_or_else(|| anyhow!("no domain in email"))?;
    let candidates = candidate_urls(email, domain);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("VFMail-Desktop/0.1")
        .build()?;

    for url in candidates {
        if let Ok(resp) = client.get(&url).send().await {
            if !resp.status().is_success() {
                continue;
            }
            if let Ok(key) = resp.json::<PublishedKey>().await {
                if key.email.eq_ignore_ascii_case(email) {
                    let entry = CacheEntry {
                        fetched_at: now_ts(),
                        source: url.clone(),
                        key: key.clone(),
                    };
                    let _ = fs::write(&cache_path, serde_json::to_vec_pretty(&entry)?);
                    return Ok(KeyLookup {
                        found: true,
                        key: Some(key),
                        source: Some(url),
                        cached: false,
                    });
                }
            }
        }
    }

    Ok(KeyLookup {
        found: false,
        key: None,
        source: None,
        cached: false,
    })
}

fn candidate_urls(email: &str, domain: &str) -> Vec<String> {
    let esc = urlencode(email);
    let local = email.split('@').next().unwrap_or("");
    vec![
        format!("https://{}/.well-known/vfmail-keys/{}.json", domain, esc),
        format!("https://mail.{}/.well-known/vfmail-keys/{}.json", domain, esc),
        format!("https://inbox.{}/.well-known/vfmail-keys/{}.json", domain, esc),
        format!("https://{}/.well-known/vfmail-keys/{}.json", domain, local),
        format!("https://inbox.{}/.well-known/vfmail-keys/{}.json", domain, local),
    ]
}

fn email_hash(email: &str) -> String {
    let mut h = Sha256::new();
    h.update(email.to_lowercase().as_bytes());
    hex::encode(h.finalize())
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
