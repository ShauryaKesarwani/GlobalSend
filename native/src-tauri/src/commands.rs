//! IPC commands exposed to the webview. Keep these thin: logic lives in
//! `globalsend-core`, and file bytes never cross this boundary (the engine
//! streams them between disk and network).

use std::str::FromStr;

use globalsend_core::{
    device::{DeviceInfo, Platform},
    lan::{FileSource, LanPeer, OutgoingFile, files::display_name_from_path},
    settings::{BackgroundMode, normalize_device_name},
    tap::TapPayload,
};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use tauri_plugin_gs_nfc::{NfcExt, NfcStatus};

use crate::native::NativeState;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn device_info() -> DeviceInfo {
    DeviceInfo::current()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    device_id: String,
    /// `None` until the user names the device (show the first-run prompt).
    device_name: Option<String>,
    /// Name currently advertised (the chosen one, or the default).
    effective_name: String,
    default_name: String,
    platform: Platform,
    download_dir: String,
    lan_port: u16,
    nfc: NfcStatus,
    /// Android: keep running when the app is closed.
    background_mode: BackgroundMode,
    nfc_auto_accept: bool,
    lan_auto_accept: bool,
    /// The folder can be changed on desktop; Android always uses Download/GlobalSend.
    can_change_download_dir: bool,
}

#[tauri::command]
pub fn app_settings<R: Runtime>(app: AppHandle<R>, state: State<'_, NativeState>) -> AppSettings {
    let settings = state.settings.lock().unwrap();
    let info = DeviceInfo::current();
    AppSettings {
        device_id: settings.device_id.clone(),
        device_name: settings.device_name.clone(),
        effective_name: settings.device_name.clone().unwrap_or_else(|| info.default_name.clone()),
        default_name: info.default_name,
        platform: info.platform,
        download_dir: state.download_dir.lock().unwrap().display().to_string(),
        lan_port: state.engine.port(),
        nfc: app.gs_nfc().status(),
        background_mode: settings.background_mode,
        nfc_auto_accept: settings.nfc_auto_accept,
        lan_auto_accept: settings.lan_auto_accept,
        can_change_download_dir: !cfg!(mobile),
    }
}

#[tauri::command]
pub fn set_device_name<R: Runtime>(app: AppHandle<R>, state: State<'_, NativeState>, name: String) -> CmdResult<String> {
    let name = normalize_device_name(&name).ok_or("Device name can't be empty")?;
    {
        let mut settings = state.settings.lock().unwrap();
        settings.device_name = Some(name.clone());
        settings.save(&state.settings_path).map_err(|e| format!("Could not save settings: {e}"))?;
    }
    state.engine.set_alias(name.clone());
    state.sync_tap_payload(&app);
    Ok(name)
}

fn save_settings(state: &NativeState, change: impl FnOnce(&mut globalsend_core::settings::Settings)) -> CmdResult<()> {
    let mut settings = state.settings.lock().unwrap();
    change(&mut settings);
    settings.save(&state.settings_path).map_err(|e| format!("Could not save settings: {e}"))?;
    state.engine.set_accept_policy(crate::native::accept_policy(&settings));
    Ok(())
}

/// Android: off / reachable / always awake (foreground service).
#[tauri::command]
pub async fn set_background_mode<R: Runtime>(app: AppHandle<R>, state: State<'_, NativeState>, mode: BackgroundMode) -> CmdResult<()> {
    app.gs_nfc().set_presence(crate::native::background_mode_name(mode)).await.map_err(|e| e.to_string())?;
    save_settings(&state, |s| s.background_mode = mode)
}

#[tauri::command]
pub fn set_auto_accept(state: State<'_, NativeState>, nfc: bool, lan: bool) -> CmdResult<()> {
    save_settings(&state, |s| {
        s.nfc_auto_accept = nfc;
        s.lan_auto_accept = lan;
    })
}

/// Desktop: change where received files go (`None` = back to the default).
#[tauri::command]
pub fn set_download_dir<R: Runtime>(app: AppHandle<R>, state: State<'_, NativeState>, path: Option<String>) -> CmdResult<String> {
    let dir = match &path {
        Some(p) => std::path::PathBuf::from(p),
        None => crate::native::pick_download_dir(&app),
    };
    if !crate::native::writable(&dir) {
        return Err(format!("Can't save files in {}", dir.display()));
    }
    save_settings(&state, |s| s.download_dir = path)?;
    state.engine.set_download_dir(dir.clone());
    *state.download_dir.lock().unwrap() = dir.clone();
    Ok(dir.display().to_string())
}

/// The webview's signaling-server session id (None when offline) and the public
/// website origin. Advertised on LAN and in the NFC tag so peers can fall back
/// to WebRTC, and so browsers / phones without the app can tap.
#[tauri::command]
pub fn set_signaling_id<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NativeState>,
    id: Option<String>,
    site_url: Option<String>,
) {
    state.engine.set_signaling_id(id.filter(|id| !id.is_empty()));
    state.engine.set_site_url(site_url.filter(|url| !url.is_empty()));
    state.sync_tap_payload(&app);
}

#[tauri::command]
pub fn lan_peers(state: State<'_, NativeState>) -> Vec<LanPeer> {
    state.engine.peers()
}

#[tauri::command]
pub fn lan_refresh(state: State<'_, NativeState>) {
    state.engine.refresh();
}

#[derive(serde::Deserialize)]
pub struct PathFile {
    /// Path or Android `content://` URI.
    path: String,
    /// Display name (from `describe_files`), since URIs often lack one.
    name: String,
}

/// Sends native files to a LAN peer. Rust reads them straight from disk, so
/// nothing passes through the webview and LAN runs at full Wi-Fi speed.
#[tauri::command]
pub fn lan_send<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NativeState>,
    peer_id: String,
    files: Vec<PathFile>,
    tap_token: Option<String>,
) -> CmdResult<String> {
    let mut outgoing = Vec::with_capacity(files.len());
    for PathFile { path, name } in files {
        let file_path = FilePath::from_str(&path).unwrap_or_else(|never| match never {});
        let mut options = OpenOptions::new();
        options.read(true);
        let file = app.fs().open(file_path, options).map_err(|e| format!("Could not open {name}: {e}"))?;
        let size = file.metadata().map_err(|e| format!("Could not read {name}: {e}"))?.len();
        outgoing.push(OutgoingFile { mime_type: guess_mime(&name).to_owned(), name, size, source: FileSource::Disk(file) });
    }
    state.engine.send_files(&peer_id, outgoing, tap_token).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFileInfo {
    /// Path or Android `content://` URI; pass to `lan_send`.
    path: String,
    name: String,
    size: u64,
    mime_type: String,
    /// Loopback URL the UI reads byte ranges from (add `&start=..&end=..`).
    url: String,
}

/// Turns picked or dropped paths into file references the UI can list and send:
/// LAN sends read them from disk in Rust, WebRTC sends read ranges via `url`.
#[tauri::command]
pub async fn describe_files<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NativeState>,
    paths: Vec<String>,
) -> CmdResult<Vec<NativeFileInfo>> {
    let mut described = Vec::with_capacity(paths.len());
    for path in paths {
        let open = {
            let app = app.clone();
            let path = path.clone();
            move || {
                let mut options = OpenOptions::new();
                options.read(true);
                app.fs().open(FilePath::from_str(&path).unwrap_or_else(|never| match never {}), options)
            }
        };
        let file = open().map_err(|e| format!("Could not open {path}: {e}"))?;
        let size = file.metadata().map_err(|e| format!("Could not read {path}: {e}"))?.len();
        // content:// URIs are often just ids; ask Android for the real name.
        let real_name = if path.starts_with("content://") { app.gs_nfc().display_name(&path).await } else { None };
        let name = real_name.unwrap_or_else(|| display_name_from_path(&path));
        let url = state.engine.register_local_file(size, Box::new(open));
        described.push(NativeFileInfo { mime_type: guess_mime(&name).to_owned(), name, size, url, path });
    }
    Ok(described)
}

/// How many pushed chunks may wait in memory per file before the web UI has to wait.
const BUFFERED_CHUNKS: usize = 4;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFile {
    name: String,
    size: u64,
    mime_type: String,
}

/// Sends files the web UI holds as `File` objects (picked in the page, dropped or
/// shared), which have no path. The page then pushes each file's bytes in order
/// with `lan_push_chunk`; the bounded channel keeps memory flat.
#[tauri::command]
pub fn lan_send_web(
    state: State<'_, NativeState>,
    peer_id: String,
    files: Vec<WebFile>,
    tap_token: Option<String>,
) -> CmdResult<String> {
    let (outgoing, senders): (Vec<_>, Vec<_>) = files
        .into_iter()
        .map(|f| OutgoingFile::stream(f.name, f.size, f.mime_type, BUFFERED_CHUNKS))
        .unzip();
    let transfer_id = state.engine.send_files(&peer_id, outgoing, tap_token).map_err(|e| e.to_string())?;
    let mut uploads = state.uploads.lock().unwrap();
    for (index, sender) in senders.into_iter().enumerate() {
        uploads.insert((transfer_id.clone(), index), sender);
    }
    Ok(transfer_id)
}

/// One chunk of a `lan_send_web` file, base64-encoded. An empty chunk ends the
/// file. Base64 in normal arguments because Android's IPC carries text only
/// (raw byte bodies arrive as JSON number arrays there). Errors once the
/// transfer is gone (declined, cancelled, failed) so the page stops reading.
#[tauri::command]
pub async fn lan_push_chunk(
    state: State<'_, NativeState>,
    transfer_id: String,
    file_index: usize,
    data: String,
) -> CmdResult<()> {
    use base64::Engine as _;
    let key = (transfer_id, file_index);
    if data.is_empty() {
        state.uploads.lock().unwrap().remove(&key); // dropping the sender ends the file
        return Ok(());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("bad chunk: {e}"))?;
    let sender = state.uploads.lock().unwrap().get(&key).cloned().ok_or("transfer is no longer active")?;
    if sender.send(bytes).await.is_err() {
        state.uploads.lock().unwrap().retain(|(id, _), _| *id != key.0);
        return Err("transfer is no longer active".into());
    }
    Ok(())
}

#[tauri::command]
pub fn lan_respond(state: State<'_, NativeState>, request_id: String, accept: bool) -> bool {
    state.engine.respond(&request_id, accept)
}

#[tauri::command]
pub fn lan_cancel(state: State<'_, NativeState>, transfer_id: String) {
    state.engine.cancel(&transfer_id);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TapResult {
    payload: TapPayload,
    /// Set when the tapped device answered on the LAN: send with `lan_send`.
    /// Otherwise use WebRTC with `payload.ws`, passing `payload.token`.
    lan_peer: Option<LanPeer>,
}

/// Turns on NFC reader mode and waits for the user to tap another phone.
#[tauri::command]
pub async fn nfc_read_tap<R: Runtime>(app: AppHandle<R>, state: State<'_, NativeState>) -> CmdResult<TapResult> {
    let raw = app.gs_nfc().read_tap().await.map_err(|e| e.to_string())?;
    let payload: TapPayload = serde_json::from_str(&raw).map_err(|e| format!("Unreadable tap data: {e}"))?;
    let lan_peer = state.engine.connect_tap(&payload).await;
    Ok(TapResult { payload, lan_peer })
}

#[tauri::command]
pub fn nfc_cancel_read<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    app.gs_nfc().cancel_read().map_err(|e| e.to_string())
}

/// For WebRTC transfers that started with a tap: true means auto-accept.
/// Burns the token, so call it once per incoming invite.
#[tauri::command]
pub fn verify_tap_token(state: State<'_, NativeState>, token: String) -> bool {
    if !state.settings.lock().unwrap().nfc_auto_accept {
        return false;
    }
    match state.tap.verify_and_consume(&token) {
        Ok(()) => true,
        Err(err) => {
            log::info!("tap token rejected: {err}");
            false
        }
    }
}

fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "txt" => "text/plain",
        "apk" => "application/vnd.android.package-archive",
        _ => "application/octet-stream",
    }
}
