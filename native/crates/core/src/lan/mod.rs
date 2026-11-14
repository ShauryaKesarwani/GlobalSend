//! LAN discovery and transfer engine.
//!
//! Devices running GlobalSend on the same network (in the foreground or in the
//! background) find each other via UDP multicast and send files directly over
//! HTTP, with no internet or signaling server involved. See [`protocol`] for the
//! wire format.
//!
//! Usage: call [`LanEngine::start`] inside a Tokio runtime and forward the
//! returned [`LanEvent`] stream to the UI.

mod client;
mod discovery;
pub mod files;
pub mod protocol;
mod server;

use std::{
    collections::HashMap,
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::Instant,
};

use serde::Serialize;
use tokio::sync::{Notify, mpsc, oneshot, watch};

use crate::{device::Platform, tap::{TapAuth, TapPayload}};
use protocol::{DeviceAnnouncement, FileMeta, PROTOCOL, VERSION};

pub struct LanConfig {
    pub device_id: String,
    pub alias: String,
    pub platform: Platform,
    /// Where received files are written.
    pub download_dir: PathBuf,
    /// Preferred TCP port for the HTTP server; falls back to a random free port.
    pub port: u16,
    /// UDP multicast port. All devices must use the same one.
    pub discovery_port: u16,
    /// Disable to run transfer-only (e.g. tests or networks without multicast).
    pub discovery: bool,
}

impl LanConfig {
    pub fn new(device_id: String, alias: String, download_dir: PathBuf) -> Self {
        Self {
            device_id,
            alias,
            platform: Platform::current(),
            download_dir,
            port: protocol::DEFAULT_PORT,
            discovery_port: protocol::DEFAULT_PORT,
            discovery: true,
        }
    }
}

/// A device found on the local network.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanPeer {
    pub id: String,
    pub alias: String,
    pub platform: Platform,
    pub address: IpAddr,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signaling_id: Option<String>,
}

impl LanPeer {
    fn from_announcement(ann: &DeviceAnnouncement, address: IpAddr) -> Self {
        Self {
            id: ann.id.clone(),
            alias: ann.alias.clone(),
            platform: ann.platform,
            address,
            port: ann.port,
            signaling_id: ann.signaling_id.clone(),
        }
    }

    fn socket_addr(&self) -> SocketAddr {
        SocketAddr::new(self.address, self.port)
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Send,
    Receive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LanEvent {
    /// The full, current list of LAN peers.
    PeersChanged { peers: Vec<LanPeer> },
    /// Someone wants to send files; answer with [`LanEngine::respond`].
    IncomingRequest { request_id: String, from: LanPeer, files: Vec<FileMeta>, total_size: u64 },
    /// An incoming request was answered or timed out.
    RequestResolved { request_id: String, accepted: bool },
    TransferStarted {
        transfer_id: String,
        direction: Direction,
        peer: LanPeer,
        files: Vec<FileMeta>,
        total_size: u64,
        /// True when an NFC tap skipped the accept prompt.
        auto_accepted: bool,
    },
    TransferProgress {
        transfer_id: String,
        direction: Direction,
        file_id: String,
        /// Bytes done across the whole transfer.
        transferred: u64,
        total_size: u64,
    },
    FileReceived { transfer_id: String, file_id: String, name: String, path: String },
    TransferFinished { transfer_id: String, direction: Direction, ok: bool, error: Option<String> },
}

/// A file to send. The caller opens it (on Android this may be a `content://`
/// URI resolved by the platform), so this crate never needs to know how.
pub struct OutgoingFile {
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub file: std::fs::File,
}

#[derive(Debug, thiserror::Error)]
pub enum LanError {
    #[error("device {0} is not on the local network")]
    UnknownPeer(String),
    #[error("no files to send")]
    NoFiles,
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("unexpected device at that address")]
    WrongDevice,
}

struct PeerEntry {
    peer: LanPeer,
    last_seen: Instant,
}

pub(crate) struct LocalDevice {
    id: String,
    alias: String,
    platform: Platform,
    signaling_id: Option<String>,
    /// Public website origin, used for the NFC connect link.
    site_url: Option<String>,
}

pub(crate) struct Inner {
    local: RwLock<LocalDevice>,
    port: u16,
    discovery_port: u16,
    download_dir: RwLock<PathBuf>,
    peers: Mutex<HashMap<String, PeerEntry>>,
    events: mpsc::UnboundedSender<LanEvent>,
    tap: Arc<TapAuth>,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    sessions: Mutex<HashMap<String, server::ReceiveSession>>,
    outgoing: Mutex<HashMap<String, watch::Sender<bool>>>,
    http: reqwest::Client,
    shutdown: watch::Sender<bool>,
    announce_now: Notify,
}

impl Inner {
    fn emit(&self, event: LanEvent) {
        let _ = self.events.send(event);
    }

    pub(crate) fn announcement(&self, announce: bool) -> DeviceAnnouncement {
        let local = self.local.read().unwrap();
        DeviceAnnouncement {
            protocol: PROTOCOL.to_owned(),
            version: VERSION,
            id: local.id.clone(),
            alias: local.alias.clone(),
            platform: local.platform,
            port: self.port,
            signaling_id: local.signaling_id.clone(),
            announce,
            leaving: false,
        }
    }

    fn is_self(&self, id: &str) -> bool {
        self.local.read().unwrap().id == id
    }

    fn peer_list(&self) -> Vec<LanPeer> {
        let mut peers: Vec<_> =
            self.peers.lock().unwrap().values().map(|e| e.peer.clone()).collect();
        peers.sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()).then(a.id.cmp(&b.id)));
        peers
    }

    /// Records a sighting of a peer; emits `PeersChanged` if the list changed.
    pub(crate) fn upsert_peer(&self, peer: LanPeer) {
        if self.is_self(&peer.id) {
            return;
        }
        let changed = {
            let mut peers = self.peers.lock().unwrap();
            let changed = peers.get(&peer.id).is_none_or(|e| e.peer != peer);
            peers.insert(peer.id.clone(), PeerEntry { peer, last_seen: Instant::now() });
            changed
        };
        if changed {
            self.emit(LanEvent::PeersChanged { peers: self.peer_list() });
        }
    }

    pub(crate) fn remove_peer(&self, id: &str) {
        if self.peers.lock().unwrap().remove(id).is_some() {
            self.emit(LanEvent::PeersChanged { peers: self.peer_list() });
        }
    }

    pub(crate) fn expire_peers(&self) {
        let removed = {
            let mut peers = self.peers.lock().unwrap();
            let before = peers.len();
            peers.retain(|_, e| e.last_seen.elapsed() < protocol::PEER_TTL);
            before != peers.len()
        };
        if removed {
            self.emit(LanEvent::PeersChanged { peers: self.peer_list() });
        }
    }
}

/// Handle to the running engine. Cheap to clone.
#[derive(Clone)]
pub struct LanEngine {
    inner: Arc<Inner>,
}

impl LanEngine {
    /// Starts the HTTP server and (unless disabled) multicast discovery.
    /// Must be called from within a Tokio runtime.
    pub async fn start(
        config: LanConfig,
        tap: Arc<TapAuth>,
    ) -> io::Result<(Self, mpsc::UnboundedReceiver<LanEvent>)> {
        let listener = match tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, config.port)).await {
            Ok(listener) => listener,
            Err(err) if config.port != 0 => {
                log::warn!("port {} unavailable ({err}); using a random port", config.port);
                tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?
            }
            Err(err) => return Err(err),
        };
        let port = listener.local_addr()?.port();
        let (events, rx) = mpsc::unbounded_channel();
        let (shutdown, _) = watch::channel(false);
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .no_proxy()
            .build()
            .map_err(io::Error::other)?;
        let inner = Arc::new(Inner {
            local: RwLock::new(LocalDevice {
                id: config.device_id,
                alias: config.alias,
                platform: config.platform,
                signaling_id: None,
                site_url: None,
            }),
            port,
            discovery_port: config.discovery_port,
            download_dir: RwLock::new(config.download_dir),
            peers: Mutex::new(HashMap::new()),
            events,
            tap,
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            outgoing: Mutex::new(HashMap::new()),
            http,
            shutdown,
            announce_now: Notify::new(),
        });

        tokio::spawn(server::serve(inner.clone(), listener));
        if config.discovery {
            let discovery_inner = inner.clone();
            tokio::spawn(async move {
                if let Err(err) = discovery::run(discovery_inner).await {
                    log::error!("LAN discovery stopped: {err}");
                }
            });
        }
        log::info!("LAN engine listening on port {port}");
        Ok((Self { inner }, rx))
    }

    pub fn port(&self) -> u16 {
        self.inner.port
    }

    pub fn peers(&self) -> Vec<LanPeer> {
        self.inner.peer_list()
    }

    /// Re-announces now, e.g. when the user opens the device list.
    pub fn refresh(&self) {
        self.inner.expire_peers();
        self.inner.announce_now.notify_one();
    }

    pub fn set_alias(&self, alias: String) {
        self.inner.local.write().unwrap().alias = alias;
        self.inner.announce_now.notify_one();
    }

    /// Advertise the signaling session id so UIs can prefer LAN for that peer.
    pub fn set_signaling_id(&self, signaling_id: Option<String>) {
        self.inner.local.write().unwrap().signaling_id = signaling_id;
        self.inner.announce_now.notify_one();
    }

    /// Website origin (e.g. `https://example.com`) for the NFC connect link.
    pub fn set_site_url(&self, site_url: Option<String>) {
        self.inner.local.write().unwrap().site_url = site_url;
    }

    pub fn set_download_dir(&self, dir: PathBuf) {
        *self.inner.download_dir.write().unwrap() = dir;
    }

    /// Payload for the NFC tag this device emulates (token added per tap).
    pub fn tap_payload_template(&self) -> TapPayload {
        let ann = self.inner.announcement(false);
        let site_url = self.inner.local.read().unwrap().site_url.clone();
        let url = crate::tap::connect_url(site_url.as_deref(), ann.signaling_id.as_deref(), &ann.alias);
        TapPayload {
            v: 1,
            id: ann.id,
            alias: ann.alias,
            platform: ann.platform,
            port: ann.port,
            ips: local_ipv4s().into_iter().map(|ip| ip.to_string()).collect(),
            ws: ann.signaling_id,
            token: None,
            url,
        }
    }

    /// Accepts or declines an [`LanEvent::IncomingRequest`]. Returns false if it already expired.
    pub fn respond(&self, request_id: &str, accept: bool) -> bool {
        let Some(tx) = self.inner.pending.lock().unwrap().remove(request_id) else {
            return false;
        };
        let delivered = tx.send(accept).is_ok();
        self.inner.emit(LanEvent::RequestResolved { request_id: request_id.to_owned(), accepted: accept && delivered });
        delivered
    }

    /// Asks a device directly (no multicast needed) and adds it to the peer list.
    pub async fn probe(&self, addr: SocketAddr, expected_id: Option<&str>) -> Result<LanPeer, LanError> {
        client::probe(&self.inner, addr, expected_id).await
    }

    /// After an NFC tap: find a LAN address where the tapped device answers.
    /// `None` means use the WebRTC fallback (`payload.ws`).
    pub async fn connect_tap(&self, payload: &TapPayload) -> Option<LanPeer> {
        if let Some(peer) = self.inner.peers.lock().unwrap().get(&payload.id) {
            return Some(peer.peer.clone());
        }
        for ip in payload.ips.iter().filter_map(|ip| ip.parse::<IpAddr>().ok()) {
            let attempt = self.probe(SocketAddr::new(ip, payload.port), Some(&payload.id));
            match tokio::time::timeout(std::time::Duration::from_millis(1500), attempt).await {
                Ok(Ok(peer)) => return Some(peer),
                Ok(Err(err)) => log::info!("tap peer not reachable at {ip}: {err}"),
                Err(_) => log::info!("tap peer timed out at {ip}"),
            }
        }
        None
    }

    /// Starts sending to a known peer and returns the transfer id. Progress and
    /// the outcome arrive as events.
    pub fn send_files(
        &self,
        peer_id: &str,
        files: Vec<OutgoingFile>,
        tap_token: Option<String>,
    ) -> Result<String, LanError> {
        if files.is_empty() {
            return Err(LanError::NoFiles);
        }
        let peer = self
            .inner
            .peers
            .lock()
            .unwrap()
            .get(peer_id)
            .map(|e| e.peer.clone())
            .ok_or_else(|| LanError::UnknownPeer(peer_id.to_owned()))?;
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.inner.outgoing.lock().unwrap().insert(transfer_id.clone(), cancel_tx);
        let inner = self.inner.clone();
        let id = transfer_id.clone();
        tokio::spawn(async move {
            let result = client::send(&inner, &id, &peer, files, tap_token, cancel_rx).await;
            inner.outgoing.lock().unwrap().remove(&id);
            let error = result.err();
            if let Some(err) = &error {
                log::warn!("send {id} to {} failed: {err}", peer.alias);
            }
            inner.emit(LanEvent::TransferFinished {
                transfer_id: id,
                direction: Direction::Send,
                ok: error.is_none(),
                error,
            });
        });
        Ok(transfer_id)
    }

    /// Cancels an outgoing transfer or drops an incoming one.
    pub fn cancel(&self, transfer_id: &str) {
        if let Some(tx) = self.inner.outgoing.lock().unwrap().get(transfer_id) {
            let _ = tx.send(true);
        }
        server::cancel_session(&self.inner, transfer_id, "cancelled");
    }

    /// Tells peers we're leaving and stops the server and discovery.
    pub async fn shutdown(&self) {
        discovery::announce_leaving(&self.inner).await;
        let _ = self.inner.shutdown.send(true);
    }
}

/// Non-loopback IPv4 addresses of this device, most likely LAN ones first.
pub fn local_ipv4s() -> Vec<Ipv4Addr> {
    let mut ips: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|iface| match iface.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => Some(ip),
            _ => None,
        })
        .collect();
    ips.sort_by_key(|ip| (!ip.is_private(), *ip));
    ips.dedup();
    ips
}
