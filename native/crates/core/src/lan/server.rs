//! Receiving side: the HTTP server every device runs.

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use tokio::{io::AsyncWriteExt, net::TcpListener, sync::oneshot};

use super::{
    Direction, Inner, LanEvent, LanPeer,
    files::{sanitize_file_name, unique_path},
    protocol::{
        ACCEPT_TIMEOUT, API, DeviceAnnouncement, MAX_FILES_PER_TRANSFER, PROTOCOL,
        PrepareRequest, PrepareResponse, SessionQuery,
    },
};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const PART_SUFFIX: &str = ".gspart";

pub(crate) struct ReceiveSession {
    token: String,
    files: HashMap<String, ReceiveFile>,
    total_size: u64,
    transferred: u64,
    remaining: usize,
}

struct ReceiveFile {
    name: String,
    dest: PathBuf,
    size: u64,
    state: FileState,
}

#[derive(PartialEq, Eq)]
enum FileState {
    Pending,
    Receiving,
    Done,
}

pub(crate) async fn serve(inner: Arc<Inner>, listener: TcpListener) {
    let app = Router::new()
        .route(&format!("{API}/info"), get(info))
        .route(&format!("{API}/register"), post(register))
        .route(&format!("{API}/prepare"), post(prepare))
        .route(&format!("{API}/upload"), post(upload).layer(DefaultBodyLimit::disable()))
        .route(&format!("{API}/cancel"), post(cancel))
        .with_state(inner.clone());
    let mut shutdown = inner.shutdown.subscribe();
    let result = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            let _ = shutdown.wait_for(|stop| *stop).await;
        })
        .await;
    if let Err(err) = result {
        log::error!("LAN server stopped: {err}");
    }
}

async fn info(State(inner): State<Arc<Inner>>) -> Json<DeviceAnnouncement> {
    Json(inner.announcement(false))
}

async fn register(
    State(inner): State<Arc<Inner>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(ann): Json<DeviceAnnouncement>,
) -> Response {
    if ann.protocol != PROTOCOL {
        return StatusCode::BAD_REQUEST.into_response();
    }
    inner.upsert_peer(LanPeer::from_announcement(&ann, addr.ip()));
    Json(inner.announcement(false)).into_response()
}

/// Removes a pending prompt if the sender hangs up before the user answers.
struct PendingGuard<'a> {
    inner: &'a Inner,
    request_id: String,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if self.inner.pending.lock().unwrap().remove(&self.request_id).is_some() {
            self.inner.emit(LanEvent::RequestResolved {
                request_id: std::mem::take(&mut self.request_id),
                accepted: false,
            });
        }
    }
}

async fn prepare(
    State(inner): State<Arc<Inner>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<PrepareRequest>,
) -> Response {
    let unique_ids: HashSet<_> = req.files.iter().map(|f| f.id.as_str()).collect();
    if req.sender.protocol != PROTOCOL
        || req.files.is_empty()
        || req.files.len() > MAX_FILES_PER_TRANSFER
        || unique_ids.len() != req.files.len()
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let peer = LanPeer::from_announcement(&req.sender, addr.ip());
    inner.upsert_peer(peer.clone());
    let total_size = req.files.iter().fold(0u64, |sum, f| sum.saturating_add(f.size));

    let auto_accepted = match req.tap_token.as_deref().map(|t| inner.tap.verify_and_consume(t)) {
        Some(Ok(())) => true,
        Some(Err(err)) => {
            log::info!("tap token from {} rejected ({err}); asking the user", peer.alias);
            false
        }
        None => false,
    };

    if !auto_accepted {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        inner.pending.lock().unwrap().insert(request_id.clone(), tx);
        let _guard = PendingGuard { inner: &inner, request_id: request_id.clone() };
        inner.emit(LanEvent::IncomingRequest {
            request_id,
            from: peer.clone(),
            files: req.files.clone(),
            total_size,
        });
        match tokio::time::timeout(ACCEPT_TIMEOUT, rx).await {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) | Ok(Err(_)) => return StatusCode::FORBIDDEN.into_response(),
            Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        }
    }

    let dir = inner.download_dir.read().unwrap().clone();
    if let Err(err) = tokio::fs::create_dir_all(&dir).await {
        log::error!("cannot create download dir {}: {err}", dir.display());
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut taken = Vec::new();
    let files = req
        .files
        .iter()
        .map(|meta| {
            let name = sanitize_file_name(&meta.name);
            let dest = unique_path(&dir, &name, &taken);
            taken.push(dest.clone());
            (meta.id.clone(), ReceiveFile { name, dest, size: meta.size, state: FileState::Pending })
        })
        .collect::<HashMap<_, _>>();

    let session_id = uuid::Uuid::new_v4().to_string();
    let token = hex::encode(rand::random::<[u8; 16]>());
    inner.sessions.lock().unwrap().insert(
        session_id.clone(),
        ReceiveSession { token: token.clone(), remaining: files.len(), files, total_size, transferred: 0 },
    );
    inner.emit(LanEvent::TransferStarted {
        transfer_id: session_id.clone(),
        direction: Direction::Receive,
        peer,
        files: req.files,
        total_size,
        auto_accepted,
    });
    Json(PrepareResponse { session_id, token }).into_response()
}

fn authorized(session: &ReceiveSession, token: &str) -> bool {
    // Tokens are random per session; a plain compare is fine on a LAN, but keep
    // it length-checked and branch-light anyway.
    session.token.len() == token.len()
        && session.token.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

async fn upload(State(inner): State<Arc<Inner>>, Query(q): Query<SessionQuery>, body: Body) -> Response {
    let Some(file_id) = q.file.clone() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let (dest, expected) = {
        let mut sessions = inner.sessions.lock().unwrap();
        let Some(session) = sessions.get_mut(&q.session).filter(|s| authorized(s, &q.token)) else {
            return StatusCode::FORBIDDEN.into_response();
        };
        let Some(file) = session.files.get_mut(&file_id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if file.state != FileState::Pending {
            return StatusCode::CONFLICT.into_response();
        }
        file.state = FileState::Receiving;
        (file.dest.clone(), file.size)
    };

    match receive_file(&inner, &q.session, &file_id, &dest, expected, body).await {
        Ok(final_path) => {
            let finished = {
                let mut sessions = inner.sessions.lock().unwrap();
                let Some(session) = sessions.get_mut(&q.session) else {
                    return StatusCode::GONE.into_response();
                };
                let name = session.files.get_mut(&file_id).map(|f| {
                    f.state = FileState::Done;
                    f.name.clone()
                });
                session.remaining -= 1;
                let finished = session.remaining == 0;
                if finished {
                    sessions.remove(&q.session);
                }
                inner.emit(LanEvent::FileReceived {
                    transfer_id: q.session.clone(),
                    file_id: file_id.clone(),
                    name: name.unwrap_or_default(),
                    path: final_path.display().to_string(),
                });
                finished
            };
            if finished {
                inner.emit(LanEvent::TransferFinished {
                    transfer_id: q.session.clone(),
                    direction: Direction::Receive,
                    ok: true,
                    error: None,
                });
            }
            StatusCode::OK.into_response()
        }
        Err((status, reason)) => {
            cancel_session(&inner, &q.session, &reason);
            (status, reason).into_response()
        }
    }
}

async fn receive_file(
    inner: &Arc<Inner>,
    session_id: &str,
    file_id: &str,
    dest: &PathBuf,
    expected: u64,
    body: Body,
) -> Result<PathBuf, (StatusCode, String)> {
    let part = dest.with_file_name(format!(
        "{}{PART_SUFFIX}",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    let io_err = |err: std::io::Error| (StatusCode::INTERNAL_SERVER_ERROR, format!("disk error: {err}"));
    let mut out = tokio::fs::File::create(&part).await.map_err(io_err)?;
    let result = async {
        let mut stream = body.into_data_stream();
        let mut written = 0u64;
        let mut last_emit = Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| (StatusCode::BAD_REQUEST, format!("connection lost: {err}")))?;
            written += chunk.len() as u64;
            if written > expected {
                return Err((StatusCode::BAD_REQUEST, "file larger than announced".to_owned()));
            }
            out.write_all(&chunk).await.map_err(io_err)?;
            let progress = {
                let mut sessions = inner.sessions.lock().unwrap();
                let Some(session) = sessions.get_mut(session_id) else {
                    return Err((StatusCode::GONE, "cancelled".to_owned()));
                };
                session.transferred += chunk.len() as u64;
                (session.transferred, session.total_size)
            };
            if last_emit.elapsed() >= PROGRESS_INTERVAL || written == expected {
                last_emit = Instant::now();
                inner.emit(LanEvent::TransferProgress {
                    transfer_id: session_id.to_owned(),
                    direction: Direction::Receive,
                    file_id: file_id.to_owned(),
                    transferred: progress.0,
                    total_size: progress.1,
                });
            }
        }
        if written != expected {
            return Err((StatusCode::BAD_REQUEST, format!("received {written} of {expected} bytes")));
        }
        out.flush().await.map_err(io_err)?;
        out.sync_all().await.map_err(io_err)?;
        Ok(())
    }
    .await;
    drop(out);
    if let Err(err) = result {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(err);
    }
    // Another app may have created the name meanwhile; never overwrite.
    let final_path = if tokio::fs::try_exists(dest).await.unwrap_or(false) {
        let dir = dest.parent().map(PathBuf::from).unwrap_or_default();
        let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_owned();
        unique_path(&dir, &name, &[])
    } else {
        dest.clone()
    };
    tokio::fs::rename(&part, &final_path).await.map_err(io_err)?;
    Ok(final_path)
}

async fn cancel(State(inner): State<Arc<Inner>>, Query(q): Query<SessionQuery>) -> StatusCode {
    let ok = inner.sessions.lock().unwrap().get(&q.session).is_some_and(|s| authorized(s, &q.token));
    if !ok {
        return StatusCode::FORBIDDEN;
    }
    cancel_session(&inner, &q.session, "cancelled by sender");
    StatusCode::OK
}

/// Drops an incoming session. In-flight uploads notice and delete their partial file.
pub(crate) fn cancel_session(inner: &Inner, session_id: &str, reason: &str) {
    if inner.sessions.lock().unwrap().remove(session_id).is_some() {
        inner.emit(LanEvent::TransferFinished {
            transfer_id: session_id.to_owned(),
            direction: Direction::Receive,
            ok: false,
            error: Some(reason.to_owned()),
        });
    }
}
