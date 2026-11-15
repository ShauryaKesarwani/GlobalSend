//! Loopback-only file access for the app's own UI.
//!
//! The web UI can't open native paths or Android `content://` URIs, so the app
//! registers picked files here and the UI reads byte ranges over HTTP from
//! `127.0.0.1` (used for WebRTC sends of native files). Requests must come from
//! this device and carry the per-launch token.

use std::{
    io::{Read, Seek, SeekFrom},
    net::SocketAddr,
    sync::Arc,
};

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use super::Inner;

/// Largest range served per request.
pub const MAX_RANGE: u64 = 8 * 1024 * 1024;

/// Opens the file again for each read (works for paths and content URIs alike).
pub type Opener = Box<dyn Fn() -> std::io::Result<std::fs::File> + Send + Sync>;

pub(crate) struct LocalFile {
    pub(crate) size: u64,
    pub(crate) open: Opener,
}

#[derive(Deserialize)]
pub(crate) struct RangeQuery {
    token: String,
    start: u64,
    end: u64,
}

pub(crate) async fn read_range(
    State(inner): State<Arc<Inner>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(q): Query<RangeQuery>,
) -> Response {
    if !addr.ip().is_loopback() || q.token != inner.local_token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some((size, file)) = inner.local_files.lock().unwrap().get(&id).map(|f| (f.size, (f.open)())) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let end = q.end.min(size);
    if q.start > end || end - q.start > MAX_RANGE {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    }
    let read = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        let mut file = file?;
        file.seek(SeekFrom::Start(q.start))?;
        let mut buf = vec![0; (end - q.start) as usize];
        file.read_exact(&mut buf)?;
        Ok(buf)
    })
    .await;
    match read {
        Ok(Ok(bytes)) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(err)) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
