// crypto.rs — vault-at-rest encryption
//
// Argon2id password → 32-byte key encryption key (KEK)
// XChaCha20-Poly1305 wraps the actual master key
//
// Same algorithms Signal / age / modern password managers use.

use anyhow::{anyhow, Context, Result};
use argon2::{Argon2, Params, Version, Algorithm};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;

use crate::vault::{KdfParams, WrappedMaster};

const MEM_KIB: u32 = 65_536; // 64 MiB
const ITER: u32 = 3;
const PARALLEL: u32 = 4;

pub fn rand_fill(dst: &mut [u8]) {
    rand::thread_rng().fill_bytes(dst);
}

pub fn derive_kek(password: &str) -> Result<(KdfParams, [u8; 32])> {
    let mut salt = [0u8; 16];
    rand_fill(&mut salt);
    let params = KdfParams {
        algo: "argon2id".to_string(),
        salt_b64: B64.encode(salt),
        mem_kib: MEM_KIB,
        iter: ITER,
        parallel: PARALLEL,
    };
    let key = derive_kek_with(&params, password)?;
    Ok((params, key))
}

pub fn derive_kek_with(params: &KdfParams, password: &str) -> Result<[u8; 32]> {
    let salt = B64.decode(&params.salt_b64).context("decode salt")?;
    let ap = Params::new(params.mem_kib, params.iter, params.parallel, Some(32))
        .map_err(|e| anyhow!("argon2 params: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, ap);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .map_err(|e| anyhow!("argon2 derive: {e}"))?;
    Ok(out)
}

pub fn wrap_key(kek: &[u8; 32], plaintext: &[u8]) -> Result<WrappedMaster> {
    let cipher = XChaCha20Poly1305::new(kek.into());
    let mut nonce = [0u8; 24];
    rand_fill(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|e| anyhow!("wrap key: {e}"))?;
    Ok(WrappedMaster {
        algo: "xchacha20poly1305".to_string(),
        nonce_b64: B64.encode(nonce),
        ct_b64: B64.encode(&ct),
    })
}

pub fn unwrap_key(kek: &[u8; 32], w: &WrappedMaster) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(kek.into());
    let nonce = B64.decode(&w.nonce_b64).context("decode nonce")?;
    let ct = B64.decode(&w.ct_b64).context("decode ciphertext")?;
    let pt = cipher
        .decrypt(XNonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| anyhow!("Wrong password."))?;
    Ok(pt)
}

/// Content-addressed hash of blob bytes — used to dedupe files in blobs/.
pub fn content_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}
