//! Encryption of catalog secrets at rest.
//!
//! A random 256-bit key lives in `<data-dir>/secret.key` (mode 0600 on Unix).
//! Secrets are stored as base64 of `nonce || AES-256-GCM ciphertext`. The key
//! file is what protects them: anyone who can read both the database and the
//! key file can decrypt.

use std::collections::BTreeMap;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{Context, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rand::RngCore;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

#[derive(Clone)]
pub struct SecretBox {
    cipher: Aes256Gcm,
}

impl SecretBox {
    /// Load the key from `path`, creating it on first use.
    pub fn load_or_create(path: &Path) -> anyhow::Result<Self> {
        let key = if path.exists() {
            let bytes = std::fs::read(path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            if bytes.len() != KEY_LEN {
                bail!(
                    "{} must contain exactly {KEY_LEN} bytes; found {}",
                    path.display(),
                    bytes.len()
                );
            }
            bytes
        } else {
            let mut bytes = vec![0u8; KEY_LEN];
            rand::rng().fill_bytes(&mut bytes);
            write_private(path, &bytes)?;
            bytes
        };
        Ok(Self::from_key(&key))
    }

    fn from_key(key: &[u8]) -> Self {
        let key = Key::<Aes256Gcm>::from_slice(key);
        Self {
            cipher: Aes256Gcm::new(key),
        }
    }

    pub fn encrypt(&self, secrets: &BTreeMap<String, String>) -> anyhow::Result<String> {
        let plaintext = serde_json::to_vec(secrets)?;
        let mut nonce = [0u8; NONCE_LEN];
        rand::rng().fill_bytes(&mut nonce);
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
            .map_err(|_| anyhow::anyhow!("failed to encrypt catalog secrets"))?;
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ciphertext);
        Ok(STANDARD.encode(blob))
    }

    pub fn decrypt(&self, encoded: &str) -> anyhow::Result<BTreeMap<String, String>> {
        let blob = STANDARD
            .decode(encoded)
            .context("stored secrets are not valid base64")?;
        if blob.len() < NONCE_LEN {
            bail!("stored secrets are truncated");
        }
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|_| {
                anyhow::anyhow!("failed to decrypt catalog secrets; was secret.key replaced?")
            })?;
        Ok(serde_json::from_slice(&plaintext)?)
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("failed to create {}", path.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
            .with_context(|| format!("failed to create {}", path.display()))?;
    }
    Ok(())
}

/// Whether a catalog property holds a credential and must be stored encrypted
/// and hidden from the UI.
pub fn is_secret_key(key: &str) -> bool {
    const MARKERS: &[&str] = &[
        "secret",
        "password",
        "token",
        "credential",
        "session",
        "access-key",
        "access_key",
        "private",
        "authorization",
    ];
    let key = key.to_ascii_lowercase();
    MARKERS.iter().any(|marker| key.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_persists_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.key");
        let secrets = BTreeMap::from([("credential".to_owned(), "id:secret".to_owned())]);

        let first = SecretBox::load_or_create(&path).unwrap();
        let encoded = first.encrypt(&secrets).unwrap();
        assert!(!encoded.contains("secret"));

        let reopened = SecretBox::load_or_create(&path).unwrap();
        assert_eq!(reopened.decrypt(&encoded).unwrap(), secrets);
    }

    #[test]
    fn rejects_a_different_key() {
        let dir = tempfile::tempdir().unwrap();
        let a = SecretBox::load_or_create(&dir.path().join("a.key")).unwrap();
        let b = SecretBox::load_or_create(&dir.path().join("b.key")).unwrap();
        let encoded = a.encrypt(&BTreeMap::new()).unwrap();
        assert!(b.decrypt(&encoded).is_err());
    }

    #[test]
    fn classifies_secret_keys() {
        for key in [
            "credential",
            "token",
            "s3.secret-access-key",
            "s3.access-key-id",
            "s3.session-token",
            "header.Authorization",
            "gcs.credentials-json",
            "aws_access_key_id",
            "aws_secret_access_key",
            "aws_session_token",
            "password",
        ] {
            assert!(is_secret_key(key), "{key} should be secret");
        }
        for key in [
            "uri",
            "warehouse",
            "s3.endpoint",
            "s3.region",
            "oauth2-server-uri",
        ] {
            assert!(!is_secret_key(key), "{key} should not be secret");
        }
    }
}
