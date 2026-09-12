// channel.rs — VF Sealed Channel client (Phase 1 of @vf/privacy-kit).
//
// The channel is a poll-based transport that hides envelope metadata:
// the server sees only `{ recipient_id: hex(sha256(signing_pub)), sealed_blob }`.
// It does not know sender identity, recipient email, or subject.
//
// This module implements the client end for a Tauri app. Three commands:
//
//   channel_send(peer_signing_pub_b64, sealed_blob_b64)
//       Anyone can drop a blob into any queue; no server-side auth.
//       (The recipient's private key is the only thing that can decrypt.)
//
//   channel_pull() -> Vec<{ msg_id, plaintext, sender, signature_verified }>
//       Prove ownership of the recipient_id via Ed25519 signed challenge,
//       pull, decrypt each blob with the identity's age key, return.
//
//   channel_ack(msg_ids)
//       Same auth as pull; deletes acknowledged blobs from server.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::identity::Identity;
use crate::mail_crypto;
use crate::AppState;

const CHANNEL_BASE: &str = "https://inbox.vfempire.com";
const CHALLENGE_PREFIX: &[u8] = b"vfch-v1|";

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn recipient_id_from_signing_pub_b64(signing_pub_b64: &str) -> Result<String> {
    let pub_bytes = B64
        .decode(signing_pub_b64)
        .map_err(|e| anyhow!("bad signing_pub_b64: {e}"))?;
    let mut h = Sha256::new();
    h.update(&pub_bytes);
    Ok(hex(&h.finalize()))
}

fn sign_challenge(id: &Identity, recipient_id: &str, ts: u64) -> Vec<u8> {
    let mut msg = Vec::with_capacity(CHALLENGE_PREFIX.len() + 8 + recipient_id.len());
    msg.extend_from_slice(CHALLENGE_PREFIX);
    msg.extend_from_slice(&ts.to_be_bytes());
    msg.extend_from_slice(recipient_id.as_bytes());
    let sk = SigningKey::from_bytes(&id.signing_seed);
    let sig: Signature = sk.sign(&msg);
    sig.to_bytes().to_vec()
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ==================================================================
// Public tauri commands
// ==================================================================

#[tauri::command]
pub async fn channel_send(
    peer_signing_pub_b64: String,
    sealed_blob_b64: String,
) -> Result<serde_json::Value, String> {
    let recipient_id =
        recipient_id_from_signing_pub_b64(&peer_signing_pub_b64).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("VFMail-Channel/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/channel/send", CHANNEL_BASE))
        .json(&serde_json::json!({
            "recipient_id": recipient_id,
            "sealed_blob_b64": sealed_blob_b64,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("channel/send failed {}: {}", status, body));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
    Ok(parsed)
}

#[tauri::command]
pub async fn channel_pull(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "identity-missing".to_string())?;
    let recipient_id = recipient_id_from_signing_pub_b64(&identity.public.signing_pub_b64)
        .map_err(|e| e.to_string())?;
    let ts = now_ts();
    let sig = sign_challenge(&identity, &recipient_id, ts);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("VFMail-Channel/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/channel/pull", CHANNEL_BASE))
        .json(&serde_json::json!({
            "recipient_id": recipient_id,
            "timestamp": ts,
            "signing_pub_b64": identity.public.signing_pub_b64,
            "signature_b64": B64.encode(&sig),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("channel/pull failed {}: {}", status, body));
    }
    let raw: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    // Open each sealed blob.
    let mut out = Vec::new();
    if let Some(msgs) = raw.get("messages").and_then(|v| v.as_array()) {
        for m in msgs {
            let msg_id = m.get("msg_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let sealed_b64 = m.get("sealed_blob_b64").and_then(|v| v.as_str()).unwrap_or("");
            let sealed_bytes = match B64.decode(sealed_b64) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let mime_body = String::from_utf8_lossy(&sealed_bytes).to_string();
            match mail_crypto::from_mime_body(&mime_body)
                .and_then(|p| mail_crypto::open(&identity, &p))
            {
                Ok(opened) => {
                    out.push(serde_json::json!({
                        "msg_id": msg_id,
                        "plaintext": String::from_utf8_lossy(&opened.plaintext),
                        "sender": opened.sender,
                        "signature_verified": opened.signature_verified,
                        "ok": true,
                    }));
                }
                Err(e) => {
                    out.push(serde_json::json!({
                        "msg_id": msg_id,
                        "ok": false,
                        "error": e.to_string(),
                    }));
                }
            }
        }
    }
    Ok(serde_json::json!({
        "ok": true,
        "messages": out,
        "truncated": raw.get("truncated").cloned().unwrap_or(serde_json::json!(false)),
    }))
}

#[tauri::command]
pub async fn channel_ack(
    msg_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if msg_ids.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "deleted": 0 }));
    }
    let identity = state
        .identity
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "identity-missing".to_string())?;
    let recipient_id = recipient_id_from_signing_pub_b64(&identity.public.signing_pub_b64)
        .map_err(|e| e.to_string())?;
    let ts = now_ts();
    let sig = sign_challenge(&identity, &recipient_id, ts);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("VFMail-Channel/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/channel/ack", CHANNEL_BASE))
        .json(&serde_json::json!({
            "recipient_id": recipient_id,
            "timestamp": ts,
            "signing_pub_b64": identity.public.signing_pub_b64,
            "signature_b64": B64.encode(&sig),
            "msg_ids": msg_ids,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("channel/ack failed {}: {}", status, body));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
    Ok(parsed)
}
