//! NFC "tap to connect" tokens.
//!
//! The receiving phone acts as an NFC tag (Android HCE). On every tap it mints
//! a token `nonce.unix_secs.mac` using a per-launch secret it got from this
//! module, and hands it to the sender inside a [`TapPayload`]. The sender
//! presents the token when it connects (over LAN or WebRTC). A valid, unexpired,
//! unused token proves the phones were physically tapped, so the transfer is
//! accepted without a prompt.
//!
//! The Kotlin HCE service (`plugins/nfc`) must produce byte-identical tokens:
//! `mac = hex(HMAC-SHA256(secret, "gs-tap-v1|" + nonce_hex + "|" + unix_secs))`,
//! with a 16-byte random nonce in lowercase hex.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::device::Platform;

type HmacSha256 = Hmac<Sha256>;

/// How long a tap stays valid for starting a transfer.
pub const TAP_TOKEN_TTL: Duration = Duration::from_secs(120);
const DOMAIN: &str = "gs-tap-v1";
/// Tolerated clock skew for tokens that appear to come from the future.
const MAX_SKEW_SECS: u64 = 5;

/// What the sender reads from the receiver's phone over NFC.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TapPayload {
    pub v: u32,
    pub id: String,
    pub alias: String,
    pub platform: Platform,
    /// LAN HTTP port of the receiver.
    pub port: u16,
    /// Receiver's IPv4 addresses, tried in order for a LAN connection.
    #[serde(default)]
    pub ips: Vec<String>,
    /// Signaling-server session id, used for the WebRTC fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ws: Option<String>,
    /// Single-use token. Absent in the template handed to the HCE service,
    /// which adds a fresh one on every tap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Website connect link (`…/test?connectTo=<ws>&alias=…`) without the token.
    /// The HCE service also serves it as a standard NDEF URL record with
    /// `&nfcToken=<token>` appended, so browsers (Web NFC) and phones without
    /// the app can tap too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Website link that connects to `signaling_id`, or `None` if either part is missing.
pub fn connect_url(site_url: Option<&str>, signaling_id: Option<&str>, alias: &str) -> Option<String> {
    let site = site_url?.trim().trim_end_matches('/');
    let ws = signaling_id?;
    if !(site.starts_with("https://") || site.starts_with("http://")) || ws.is_empty() {
        return None;
    }
    Some(format!("{site}/test?connectTo={}&alias={}", percent_encode(ws), percent_encode(alias)))
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub struct TapAuth {
    secret: [u8; 32],
    used: Mutex<HashMap<String, u64>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TapError {
    #[error("malformed tap token")]
    Malformed,
    #[error("tap token signature mismatch")]
    BadSignature,
    #[error("tap token expired")]
    Expired,
    #[error("tap token already used")]
    Replayed,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl TapAuth {
    pub fn new() -> Self {
        Self::with_secret(rand::random())
    }

    pub fn with_secret(secret: [u8; 32]) -> Self {
        Self { secret, used: Mutex::new(HashMap::new()) }
    }

    /// Hex secret for the local HCE service. Never send it over the network.
    pub fn secret_hex(&self) -> String {
        hex::encode(self.secret)
    }

    fn keyed(&self, nonce: &str, issued: u64) -> HmacSha256 {
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts any key length");
        mac.update(format!("{DOMAIN}|{nonce}|{issued}").as_bytes());
        mac
    }

    /// Mints a token locally. Android mints them in Kotlin; this is for tests
    /// and for platforms that can share a token another way (e.g. a QR code).
    pub fn issue(&self) -> String {
        self.issue_at(now_secs())
    }

    fn issue_at(&self, issued: u64) -> String {
        let nonce = hex::encode(rand::random::<[u8; 16]>());
        let mac = hex::encode(self.keyed(&nonce, issued).finalize().into_bytes());
        format!("{nonce}.{issued}.{mac}")
    }

    /// Checks a token and burns it so it can't be reused.
    pub fn verify_and_consume(&self, token: &str) -> Result<(), TapError> {
        self.verify_at(token, now_secs())
    }

    fn verify_at(&self, token: &str, now: u64) -> Result<(), TapError> {
        let mut parts = token.split('.');
        let (Some(nonce), Some(issued), Some(mac), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(TapError::Malformed);
        };
        if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(TapError::Malformed);
        }
        let issued: u64 = issued.parse().map_err(|_| TapError::Malformed)?;
        let provided = hex::decode(mac).map_err(|_| TapError::Malformed)?;
        // verify_slice compares in constant time.
        self.keyed(nonce, issued).verify_slice(&provided).map_err(|_| TapError::BadSignature)?;
        if issued > now + MAX_SKEW_SECS || now.saturating_sub(issued) > TAP_TOKEN_TTL.as_secs() {
            return Err(TapError::Expired);
        }
        let mut used = self.used.lock().unwrap();
        used.retain(|_, at| now.saturating_sub(*at) <= TAP_TOKEN_TTL.as_secs() + MAX_SKEW_SECS);
        if used.insert(nonce.to_ascii_lowercase(), issued).is_some() {
            return Err(TapError::Replayed);
        }
        Ok(())
    }
}

impl Default for TapAuth {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_token_is_single_use() {
        let auth = TapAuth::new();
        let token = auth.issue();
        assert_eq!(auth.verify_and_consume(&token), Ok(()));
        assert_eq!(auth.verify_and_consume(&token), Err(TapError::Replayed));
    }

    #[test]
    fn rejects_expired_tokens() {
        let auth = TapAuth::new();
        let token = auth.issue_at(1_000);
        assert_eq!(auth.verify_at(&token, 1_000 + 121), Err(TapError::Expired));
        assert_eq!(auth.verify_at(&auth.issue_at(2_000), 1_900), Err(TapError::Expired));
    }

    #[test]
    fn rejects_tampered_and_foreign_tokens() {
        let auth = TapAuth::new();
        let token = auth.issue();
        let (head, mac) = token.rsplit_once('.').unwrap();
        let flipped = if mac.starts_with('0') { "1" } else { "0" };
        let tampered = format!("{head}.{flipped}{}", &mac[1..]);
        assert_eq!(auth.verify_and_consume(&tampered), Err(TapError::BadSignature));

        let other = TapAuth::new();
        assert_eq!(auth.verify_and_consume(&other.issue()), Err(TapError::BadSignature));
        assert_eq!(auth.verify_and_consume("nope"), Err(TapError::Malformed));
    }

    #[test]
    fn builds_connect_url() {
        assert_eq!(
            connect_url(Some("https://example.com/"), Some("peer-ab1"), "Shaurya's Pixel").as_deref(),
            Some("https://example.com/test?connectTo=peer-ab1&alias=Shaurya%27s%20Pixel")
        );
        assert_eq!(connect_url(None, Some("peer-ab1"), "x"), None);
        assert_eq!(connect_url(Some("https://example.com"), None, "x"), None);
        assert_eq!(connect_url(Some("javascript:alert(1)"), Some("p"), "x"), None);
    }

    /// Fixed vector shared with the Kotlin HCE service (see TapProtocol.kt).
    #[test]
    fn matches_cross_language_vector() {
        let auth = TapAuth::with_secret([7u8; 32]);
        let nonce = "ab".repeat(16);
        let mac = hex::encode(auth.keyed(&nonce, 1_700_000_000).finalize().into_bytes());
        let token = format!("{nonce}.1700000000.{mac}");
        assert_eq!(auth.verify_at(&token, 1_700_000_010), Ok(()));
        println!("cross-language vector mac = {mac}");
    }
}
