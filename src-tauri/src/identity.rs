// identity.rs — the user's sovereign cryptographic identity.
//
// Two keys generated at vault creation:
//   * age X25519 identity (bech32 "AGE-SECRET-KEY-1…") for encryption
//   * Ed25519 signing key (32-byte seed)
//
// Both are stored encrypted with the vault master key. Public halves
// get published at a well-known URL on the user's own mail server so
// other VF Mail users can look them up.
//
// Private keys NEVER leave the machine.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fs;

use crate::crypto;
use crate::vault::{Vault, WrappedMaster};

const CURRENT_VERSION: u32 = 1;

/// On-disk (wrapped) representation.
#[derive(Serialize, Deserialize)]
pub struct IdentityFile {
    pub version: u32,
    pub email: String,
    pub created_at: i64,
    pub public: PublicKeys,
    pub secret_wrap: WrappedMaster,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PublicKeys {
    /// age recipient string ("age1…") — used to encrypt to this user.
    pub age_recipient: String,
    /// base64 Ed25519 verifying key — used to verify signed payloads.
    pub signing_pub_b64: String,
    /// The mail server hosting this identity's key file.
    pub host: String,
}

/// The unwrapped identity — held in memory while the vault is unlocked.
#[derive(Clone)]
pub struct Identity {
    pub email: String,
    /// bech32 age secret key string ("AGE-SECRET-KEY-1…").
    pub age_identity: String,
    pub signing_seed: [u8; 32],
    pub public: PublicKeys,
    pub created_at: i64,
}

impl Identity {
    /// Fresh identity → sealed to vault, live copy returned.
    pub fn create(v: &Vault, email: &str, host: &str) -> Result<Self> {
        // age identity
        let age_id = age::x25519::Identity::generate();
        let age_recipient = age_id.to_public().to_string();
        let age_secret_str: String = {
            use age::secrecy::ExposeSecret;
            age_id.to_string().expose_secret().clone()
        };

        // Ed25519 signing
        let mut sig_seed = [0u8; 32];
        crypto::rand_fill(&mut sig_seed);
        let sig_key = SigningKey::from_bytes(&sig_seed);
        let sig_public = sig_key.verifying_key();

        let public = PublicKeys {
            age_recipient,
            signing_pub_b64: B64.encode(sig_public.as_bytes()),
            host: host.to_string(),
        };

        // Pack secrets: [age_secret_len_be:2 | age_secret_str_bytes | sig_seed 32]
        let mut blob: Vec<u8> = Vec::with_capacity(2 + age_secret_str.len() + 32);
        let l = age_secret_str.len() as u16;
        blob.extend_from_slice(&l.to_be_bytes());
        blob.extend_from_slice(age_secret_str.as_bytes());
        blob.extend_from_slice(&sig_seed);

        let master: [u8; 32] = v
            .master_key
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("vault master key not 32 bytes"))?;
        let wrapped = crypto::wrap_key(&master, &blob)?;

        let created_at = now_ts();
        let file = IdentityFile {
            version: CURRENT_VERSION,
            email: email.to_string(),
            created_at,
            public: public.clone(),
            secret_wrap: wrapped,
        };
        fs::write(v.root.join("identity.enc"), serde_json::to_vec_pretty(&file)?)?;

        // Public key JSON for publishing at the well-known URL.
        let published = PublishedKey::from(&file);
        fs::write(
            v.root.join("identity.pub.json"),
            serde_json::to_vec_pretty(&published)?,
        )?;

        Ok(Identity {
            email: email.to_string(),
            age_identity: age_secret_str,
            signing_seed: sig_seed,
            public,
            created_at,
        })
    }

    pub fn load(v: &Vault) -> Result<Option<Self>> {
        let path = v.root.join("identity.enc");
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read(&path)?;
        let file: IdentityFile = serde_json::from_slice(&raw)?;
        let master: [u8; 32] = v
            .master_key
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("vault master key not 32 bytes"))?;
        let blob = crypto::unwrap_key(&master, &file.secret_wrap)?;
        if blob.len() < 34 {
            return Err(anyhow!("bad identity blob length"));
        }
        let l = u16::from_be_bytes([blob[0], blob[1]]) as usize;
        if blob.len() < 2 + l + 32 {
            return Err(anyhow!("identity blob truncated"));
        }
        let age_id = std::str::from_utf8(&blob[2..2 + l])?.to_string();
        let mut sig_seed = [0u8; 32];
        sig_seed.copy_from_slice(&blob[2 + l..2 + l + 32]);
        Ok(Some(Identity {
            email: file.email,
            age_identity: age_id,
            signing_seed: sig_seed,
            public: file.public,
            created_at: file.created_at,
        }))
    }

    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        let sk = SigningKey::from_bytes(&self.signing_seed);
        let sig: Signature = sk.sign(msg);
        sig.to_bytes().to_vec()
    }

    pub fn well_known_url(&self) -> String {
        format!(
            "https://{}/.well-known/vfmail-keys/{}.json",
            self.public.host,
            urlencode(&self.email)
        )
    }
}

/// Public JSON blob served from the well-known URL.
#[derive(Serialize, Deserialize, Clone)]
pub struct PublishedKey {
    pub version: u32,
    pub email: String,
    pub host: String,
    pub age_recipient: String,
    pub signing_pub_b64: String,
    pub created_at: i64,
}
impl From<&IdentityFile> for PublishedKey {
    fn from(f: &IdentityFile) -> Self {
        PublishedKey {
            version: f.version,
            email: f.email.clone(),
            host: f.public.host.clone(),
            age_recipient: f.public.age_recipient.clone(),
            signing_pub_b64: f.public.signing_pub_b64.clone(),
            created_at: f.created_at,
        }
    }
}

pub fn verify_signature(signing_pub_b64: &str, msg: &[u8], sig_b64: &str) -> Result<bool> {
    let pk_bytes: [u8; 32] = B64
        .decode(signing_pub_b64)
        .context("decode signing pub")?
        .try_into()
        .map_err(|_| anyhow!("signing pub not 32 bytes"))?;
    let vk = VerifyingKey::from_bytes(&pk_bytes).map_err(|e| anyhow!("bad vk: {e}"))?;
    let sig_bytes: [u8; 64] = B64
        .decode(sig_b64)
        .context("decode signature")?
        .try_into()
        .map_err(|_| anyhow!("signature not 64 bytes"))?;
    let sig = Signature::from_bytes(&sig_bytes);
    Ok(vk.verify(msg, &sig).is_ok())
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
