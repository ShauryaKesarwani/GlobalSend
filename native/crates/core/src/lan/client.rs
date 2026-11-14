//! Sending side: talks to other devices' HTTP servers.

use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use reqwest::StatusCode;
use tokio::sync::watch;
use tokio_util::io::ReaderStream;

use super::{
    Direction, Inner, LanError, LanEvent, LanPeer, OutgoingFile,
    protocol::{ACCEPT_TIMEOUT, API, DeviceAnnouncement, FileMeta, PROTOCOL, PrepareRequest, PrepareResponse},
};

const READ_CHUNK: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

fn url(addr: SocketAddr, path: &str) -> String {
    format!("http://{addr}{API}/{path}")
}

/// Introduces ourselves to a device that just announced itself.
pub(crate) async fn register(inner: &Inner, addr: SocketAddr) -> Result<(), LanError> {
    let ann: DeviceAnnouncement = inner
        .http
        .post(url(addr, "register"))
        .json(&inner.announcement(false))
        .timeout(Duration::from_secs(3))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if ann.protocol == PROTOCOL {
        inner.upsert_peer(LanPeer::from_announcement(&ann, addr.ip()));
    }
    Ok(())
}

pub(crate) async fn probe(
    inner: &Arc<Inner>,
    addr: SocketAddr,
    expected_id: Option<&str>,
) -> Result<LanPeer, LanError> {
    let ann: DeviceAnnouncement = inner
        .http
        .get(url(addr, "info"))
        .timeout(Duration::from_secs(2))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if ann.protocol != PROTOCOL || expected_id.is_some_and(|id| id != ann.id) {
        return Err(LanError::WrongDevice);
    }
    let peer = LanPeer::from_announcement(&ann, addr.ip());
    inner.upsert_peer(peer.clone());
    // Let them list us too, without waiting for the next multicast round.
    let inner = inner.clone();
    tokio::spawn(async move {
        let _ = register(&inner, addr).await;
    });
    Ok(peer)
}

async fn cancelled(rx: &mut watch::Receiver<bool>) {
    if rx.wait_for(|stop| *stop).await.is_err() {
        std::future::pending::<()>().await;
    }
}

pub(crate) async fn send(
    inner: &Arc<Inner>,
    transfer_id: &str,
    peer: &LanPeer,
    files: Vec<OutgoingFile>,
    tap_token: Option<String>,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let addr = peer.socket_addr();
    let metas: Vec<FileMeta> = files
        .iter()
        .enumerate()
        .map(|(i, f)| FileMeta {
            id: i.to_string(),
            name: f.name.clone(),
            size: f.size,
            mime_type: f.mime_type.clone(),
        })
        .collect();
    let total_size = metas.iter().fold(0u64, |sum, f| sum.saturating_add(f.size));
    inner.emit(LanEvent::TransferStarted {
        transfer_id: transfer_id.to_owned(),
        direction: Direction::Send,
        peer: peer.clone(),
        files: metas.clone(),
        total_size,
        auto_accepted: tap_token.is_some(),
    });

    let request = PrepareRequest { sender: inner.announcement(false), files: metas.clone(), tap_token };
    let prepare = inner
        .http
        .post(url(addr, "prepare"))
        .json(&request)
        .timeout(ACCEPT_TIMEOUT + Duration::from_secs(15))
        .send();
    let response = tokio::select! {
        response = prepare => response.map_err(|err| format!("could not reach {}: {err}", peer.alias))?,
        _ = cancelled(&mut cancel) => return Err("cancelled".to_owned()),
    };
    let session: PrepareResponse = match response.status() {
        StatusCode::OK => response.json().await.map_err(|err| format!("bad response: {err}"))?,
        StatusCode::FORBIDDEN => return Err("declined".to_owned()),
        StatusCode::REQUEST_TIMEOUT => return Err("no response from receiver".to_owned()),
        status => return Err(format!("receiver error ({status})")),
    };

    let transferred = Arc::new(AtomicU64::new(0));
    for (meta, file) in metas.into_iter().zip(files) {
        let body = progress_body(inner.clone(), transfer_id.to_owned(), meta.id.clone(), file.file, transferred.clone(), total_size);
        let upload = inner
            .http
            .post(url(addr, "upload"))
            .query(&[("session", &session.session_id), ("token", &session.token), ("file", &meta.id)])
            .header(reqwest::header::CONTENT_LENGTH, meta.size)
            .body(body)
            .send();
        tokio::select! {
            result = upload => {
                let response = result.map_err(|err| format!("upload of {} failed: {err}", meta.name))?;
                if !response.status().is_success() {
                    let reason = response.text().await.unwrap_or_default();
                    return Err(format!("{} was rejected: {reason}", meta.name));
                }
            }
            _ = cancelled(&mut cancel) => {
                let _ = inner
                    .http
                    .post(url(addr, "cancel"))
                    .query(&[("session", &session.session_id), ("token", &session.token)])
                    .timeout(Duration::from_secs(3))
                    .send()
                    .await;
                return Err("cancelled".to_owned());
            }
        }
    }
    Ok(())
}

fn progress_body(
    inner: Arc<Inner>,
    transfer_id: String,
    file_id: String,
    file: std::fs::File,
    transferred: Arc<AtomicU64>,
    total_size: u64,
) -> reqwest::Body {
    let mut last_emit = Instant::now();
    let stream = ReaderStream::with_capacity(tokio::fs::File::from_std(file), READ_CHUNK).map(move |chunk| {
        if let Ok(bytes) = &chunk {
            let done = transferred.fetch_add(bytes.len() as u64, Ordering::Relaxed) + bytes.len() as u64;
            if last_emit.elapsed() >= PROGRESS_INTERVAL || done >= total_size {
                last_emit = Instant::now();
                inner.emit(LanEvent::TransferProgress {
                    transfer_id: transfer_id.clone(),
                    direction: Direction::Send,
                    file_id: file_id.clone(),
                    transferred: done,
                    total_size,
                });
            }
        }
        chunk
    });
    reqwest::Body::wrap_stream(stream)
}
