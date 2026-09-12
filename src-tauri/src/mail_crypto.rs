// mail_crypto.rs — VF Mail end-to-end encryption pipeline.
//
// Wire format ("application/vnd.vfmail.age-v1"):
//   {
//     "v": 1,
//     "sender": "vincent@vfempire.com",
//     "sender_sig_pub": "<b64 Ed25519 pub>",
//     "recipients": ["age1…", ...],
//     "ciphertext_b64": "<age-encrypted body>",
//     "signature_b64": "<Ed25519 sig over sha256(plaintext)>"
//   }
//
// The MIME envelope wraps that JSON as a text body with content-type
// "application/vnd.vfmail.age-v1". Any SMTP path can carry it; only a
// VF Mail client can decrypt.
//
// Plaintext lives ONLY inside process memory after decrypt. Nothing
// touches disk in clear form.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

use crate::identity::{verify_signature, Identity};

#[allow(dead_code)] // wire-format tag; also asserted from JS side
pub const CONTENT_TYPE: &str = "application/vnd.vfmail.age-v1";

#[derive(Serialize, Deserialize, Clone)]
pub struct SealedPayload {
    pub v: u32,
    pub sender: String,
    pub sender_sig_pub: String,
    pub recipients: Vec<String>,
    pub ciphertext_b64: String,
    pub signature_b64: String,
}

pub struct RecipientKey {
    pub email: String,
    /// age recipient string ("age1…").
    pub age_recipient: String,
    #[allow(dead_code)] // recorded per-recipient for future receipt verification
    pub signing_pub_b64: String,
}

/// Encrypt a plaintext body for one or more VF Mail recipients + sign it.
pub fn seal(
    sender: &Identity,
    recipients: &[RecipientKey],
    plaintext: &[u8],
) -> Result<SealedPayload> {
    let mut age_recipients: Vec<Box<dyn age::Recipient + Send>> = Vec::new();
    let mut rec_str_list: Vec<String> = Vec::new();
    for r in recipients {
        let recipient: age::x25519::Recipient = r
            .age_recipient
            .parse()
            .map_err(|e| anyhow!("bad age recipient for {}: {:?}", r.email, e))?;
        age_recipients.push(Box::new(recipient));
        rec_str_list.push(r.age_recipient.clone());
    }

    let encryptor = age::Encryptor::with_recipients(age_recipients)
        .ok_or_else(|| anyhow!("no recipients supplied"))?;
    let mut out = Vec::new();
    {
        let mut w = encryptor
            .wrap_output(&mut out)
            .map_err(|e| anyhow!("age wrap: {e}"))?;
        w.write_all(plaintext)?;
        w.finish().map_err(|e| anyhow!("age finish: {e}"))?;
    }

    // Detached signature over sha256(plaintext) — verifies sender identity
    // and integrity without exposing anything extra.
    let mut hasher = Sha256::new();
    hasher.update(plaintext);
    let digest = hasher.finalize();
    let sig = sender.sign(&digest);

    Ok(SealedPayload {
        v: 1,
        sender: sender.email.clone(),
        sender_sig_pub: sender.public.signing_pub_b64.clone(),
        recipients: rec_str_list,
        ciphertext_b64: B64.encode(&out),
        signature_b64: B64.encode(&sig),
    })
}

pub struct OpenResult {
    pub plaintext: Vec<u8>,
    pub sender: String,
    pub signature_verified: bool,
}

/// Decrypt a sealed payload and verify sender signature.
pub fn open(recipient: &Identity, payload: &SealedPayload) -> Result<OpenResult> {
    if payload.v != 1 {
        return Err(anyhow!("unsupported payload version {}", payload.v));
    }
    let ct = B64
        .decode(&payload.ciphertext_b64)
        .context("decode ciphertext")?;
    let identity: age::x25519::Identity = recipient
        .age_identity
        .parse()
        .map_err(|e| anyhow!("bad age identity: {:?}", e))?;

    let decryptor = match age::Decryptor::new(ct.as_slice())
        .map_err(|e| anyhow!("age decrypt init: {e}"))?
    {
        age::Decryptor::Recipients(d) => d,
        _ => return Err(anyhow!("not a recipient-encrypted payload")),
    };

    let ids: [&dyn age::Identity; 1] = [&identity];
    let mut plaintext = Vec::new();
    {
        let mut r = decryptor
            .decrypt(ids.iter().copied())
            .map_err(|e| anyhow!("age decrypt: {e}"))?;
        r.read_to_end(&mut plaintext)?;
    }

    let mut hasher = Sha256::new();
    hasher.update(&plaintext);
    let digest = hasher.finalize();
    let ok = verify_signature(&payload.sender_sig_pub, &digest, &payload.signature_b64)
        .unwrap_or(false);

    Ok(OpenResult {
        plaintext,
        sender: payload.sender.clone(),
        signature_verified: ok,
    })
}

pub fn to_mime_body(payload: &SealedPayload) -> Result<String> {
    Ok(serde_json::to_string_pretty(payload)?)
}
pub fn from_mime_body(body: &str) -> Result<SealedPayload> {
    Ok(serde_json::from_str(body)?)
}
