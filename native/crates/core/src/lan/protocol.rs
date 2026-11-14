//! Wire format of the GlobalSend LAN protocol (v1).
//!
//! Discovery: every device multicasts a [`DeviceAnnouncement`] (JSON) to
//! [`MULTICAST_GROUP`]:[`DEFAULT_PORT`] when it starts and every
//! [`ANNOUNCE_INTERVAL`]. Devices that hear an announcement with
//! `announce: true` answer the sender directly with `POST /register`.
//!
//! Transfer: plain HTTP on the announced port.
//! 1. `POST {API}/prepare` with [`PrepareRequest`]. The receiver accepts at once for
//!    a valid NFC tap token, otherwise it asks its user. Answers [`PrepareResponse`]
//!    or 403 (declined) / 408 (no answer).
//! 2. `POST {API}/upload?session=..&token=..&file=..` with the raw file bytes, once per file.
//! 3. `POST {API}/cancel?session=..&token=..` to abort.
//!
//! The shape follows LocalSend's v2 API on purpose, so a LocalSend-compatible
//! mode can be added as a second listener later. It uses its own port and API
//! prefix so the two never confuse each other.
//!
//! Not yet encrypted: LAN traffic is plain HTTP. HTTPS with pinned
//! self-signed certificates is tracked in docs/TODO.md.

use std::{net::Ipv4Addr, time::Duration};

use serde::{Deserialize, Serialize};

use crate::device::Platform;

pub const PROTOCOL: &str = "globalsend-lan";
pub const VERSION: u32 = 1;
/// Link-local multicast group (not routed beyond the local network).
pub const MULTICAST_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
/// UDP discovery port and preferred TCP port. LocalSend uses 53317.
pub const DEFAULT_PORT: u16 = 53318;
pub const API: &str = "/api/globalsend/v1";
pub const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(10);
/// A peer that hasn't been heard from for this long is dropped from the list.
pub const PEER_TTL: Duration = Duration::from_secs(35);
/// How long the receiver waits for its user to accept or decline.
pub const ACCEPT_TIMEOUT: Duration = Duration::from_secs(90);
pub const MAX_FILES_PER_TRANSFER: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAnnouncement {
    pub protocol: String,
    pub version: u32,
    pub id: String,
    pub alias: String,
    pub platform: Platform,
    /// TCP port of the device's HTTP server.
    pub port: u16,
    /// Signaling-server session id while the device is online, so UIs can
    /// tell that a website-listed peer is also reachable over LAN.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signaling_id: Option<String>,
    /// `true` asks listeners to answer with `/register`.
    #[serde(default)]
    pub announce: bool,
    /// Sent once on shutdown so peers can drop the device immediately.
    #[serde(default)]
    pub leaving: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    /// Sender-chosen id, unique within the transfer.
    pub id: String,
    pub name: String,
    pub size: u64,
    #[serde(default = "default_mime")]
    pub mime_type: String,
}

fn default_mime() -> String {
    "application/octet-stream".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    pub sender: DeviceAnnouncement,
    pub files: Vec<FileMeta>,
    /// NFC tap token; a valid one skips the accept prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponse {
    pub session_id: String,
    /// Per-session secret required by `/upload` and `/cancel`.
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionQuery {
    pub session: String,
    pub token: String,
    #[serde(default)]
    pub file: Option<String>,
}
