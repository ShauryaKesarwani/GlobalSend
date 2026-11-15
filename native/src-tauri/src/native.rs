//! Long-lived native state: settings, the LAN engine and the NFC tag payload.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use globalsend_core::{
    device::DeviceInfo,
    lan::{Direction, LanConfig, LanEngine, LanEvent},
    settings::Settings,
    tap::TapAuth,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_gs_nfc::NfcExt;

/// Event name the webview listens on for every `LanEvent`.
pub const LAN_EVENT: &str = "lan-event";
/// How often the NFC tag payload is refreshed so it carries current IPs.
const TAP_PAYLOAD_REFRESH: Duration = Duration::from_secs(30);

pub struct NativeState {
    pub engine: LanEngine,
    pub tap: Arc<TapAuth>,
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub download_dir: PathBuf,
    /// Chunk senders for files the web UI streams in, keyed by (transfer id, file index).
    pub uploads: Mutex<HashMap<(String, usize), tokio::sync::mpsc::Sender<Vec<u8>>>>,
}

impl NativeState {
    pub async fn start<R: Runtime>(app: &AppHandle<R>) -> Result<Self, Box<dyn std::error::Error>> {
        let settings_path = app.path().app_config_dir()?.join("settings.json");
        let settings = Settings::load_or_create(&settings_path)?;
        let alias = settings.device_name.clone().unwrap_or_else(|| DeviceInfo::current().default_name);
        let download_dir = pick_download_dir(app);
        log::info!("received files go to {}", download_dir.display());

        if let Err(err) = app.gs_nfc().acquire_multicast_lock() {
            log::warn!("multicast lock unavailable, LAN discovery may not work: {err}");
        }

        let tap = Arc::new(TapAuth::new());
        let config = LanConfig::new(settings.device_id.clone(), alias, download_dir.clone());
        let (engine, mut events) = LanEngine::start(config, tap.clone()).await?;

        let emitter = app.clone();
        let status = transfer_status_task(app.clone());
        tauri::async_runtime::spawn(async move {
            let mut active = ActiveTransfers::default();
            while let Some(event) = events.recv().await {
                if let Some(update) = active.apply(&event) {
                    let _ = status.send(update);
                }
                notify_request_event(&emitter, &event);
                // On Android files land in the app's private folder first; move each
                // into the public Download/GlobalSend folder before telling the UI.
                if let LanEvent::FileReceived { transfer_id, file_id, name, path } = event {
                    let app = emitter.clone();
                    tauri::async_runtime::spawn(async move {
                        let path = match app.gs_nfc().publish_download(&path, &name).await {
                            Ok(public) => public,
                            Err(err) => {
                                log::warn!("could not move {name} to Downloads: {err}");
                                path
                            }
                        };
                        let _ = app.emit(LAN_EVENT, &LanEvent::FileReceived { transfer_id, file_id, name, path });
                    });
                    continue;
                }
                if let Err(err) = emitter.emit(LAN_EVENT, &event) {
                    log::warn!("could not forward LAN event: {err}");
                }
            }
        });

        let state = Self {
            engine,
            tap,
            settings: Mutex::new(settings),
            settings_path,
            download_dir,
            uploads: Mutex::new(HashMap::new()),
        };
        state.sync_tap_payload(app);
        spawn_request_action_loop(app.clone());
        if state.settings.lock().unwrap().stay_reachable {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = app.gs_nfc().set_presence(true).await {
                    log::warn!("could not stay reachable in background: {err}");
                }
            });
        }

        let refresher = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(TAP_PAYLOAD_REFRESH);
            loop {
                ticker.tick().await;
                if let Some(state) = refresher.try_state::<NativeState>() {
                    state.sync_tap_payload(&refresher);
                }
            }
        });
        Ok(state)
    }

    /// Hands the current name/IPs/port/signaling id to the NFC tag emulation.
    pub fn sync_tap_payload<R: Runtime>(&self, app: &AppHandle<R>) {
        let template = match serde_json::to_string(&self.engine.tap_payload_template()) {
            Ok(json) => json,
            Err(err) => return log::error!("tap payload: {err}"),
        };
        if let Err(err) = app.gs_nfc().set_tap_payload(&template, &self.tap.secret_hex()) {
            log::warn!("could not update NFC tag payload: {err}");
        }
    }
}

/// First writable of: public Download/GlobalSend (Android 11+ allows writing
/// there directly, as LocalSend does), the platform's Downloads/GlobalSend, and
/// finally the app's own data folder.
fn pick_download_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let mut candidates = Vec::new();
    if cfg!(target_os = "android") {
        let storage = std::env::var("EXTERNAL_STORAGE").unwrap_or_else(|_| "/storage/emulated/0".into());
        candidates.push(PathBuf::from(storage).join("Download").join("GlobalSend"));
    }
    if let Ok(downloads) = app.path().download_dir() {
        candidates.push(downloads.join("GlobalSend"));
    }
    let writable = |dir: &PathBuf| {
        let probe = dir.join(".globalsend-write-test");
        let ok = std::fs::create_dir_all(dir).is_ok() && std::fs::write(&probe, b"").is_ok();
        let _ = std::fs::remove_file(&probe);
        ok
    };
    candidates.into_iter().find(writable).unwrap_or_else(|| {
        app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("received")
    })
}

/// Tells the user about an incoming request when they aren't looking at the app:
/// Android shows Accept/Decline buttons; desktop shows a notification and
/// flashes the taskbar (the prompt is in the app window).
fn notify_request_event<R: Runtime>(app: &AppHandle<R>, event: &LanEvent) {
    match event {
        LanEvent::IncomingRequest { request_id, from, files, total_size } => {
            let what = if files.len() == 1 { files[0].name.clone() } else { format!("{} files", files.len()) };
            let title = format!("{} wants to send you {what}", from.alias);
            let text = format!("{:.1} MB · over your local network", *total_size as f64 / 1_048_576.0);
            if cfg!(target_os = "android") {
                let (app, id) = (app.clone(), request_id.clone());
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = app.gs_nfc().notify_request(&id, &title, &text).await {
                        log::warn!("request notification: {err}");
                    }
                });
            } else if let Some(window) = app.get_webview_window("main") {
                if !window.is_focused().unwrap_or(false) {
                    use tauri_plugin_notification::NotificationExt;
                    if let Err(err) = app.notification().builder().title(&title).body("Open GlobalSend to accept or decline").show() {
                        log::warn!("request notification: {err}");
                    }
                    #[cfg(desktop)]
                    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
                }
            }
        }
        LanEvent::RequestResolved { request_id, .. } if cfg!(target_os = "android") => {
            let (app, id) = (app.clone(), request_id.clone());
            tauri::async_runtime::spawn(async move {
                let _ = app.gs_nfc().cancel_request(&id).await;
            });
        }
        _ => {}
    }
}

/// Applies Accept/Decline presses from Android notifications, even when the
/// web page isn't running.
fn spawn_request_action_loop<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match app.gs_nfc().next_request_action().await {
                Ok((request_id, accept)) => {
                    if let Some(state) = app.try_state::<NativeState>() {
                        state.engine.respond(&request_id, accept);
                    }
                }
                Err(err) => {
                    log::warn!("notification actions: {err}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

/// What the background-transfer notification should show; `None` stops it.
type TransferStatus = Option<(String, String, i32)>;
const STATUS_INTERVAL: Duration = Duration::from_secs(1);

/// Tracks running transfers to drive the Android foreground service.
#[derive(Default)]
struct ActiveTransfers {
    transfers: HashMap<String, (String, u64, u64)>,
    last_update: Option<Instant>,
}

impl ActiveTransfers {
    /// Returns a new notification state when it should change.
    fn apply(&mut self, event: &LanEvent) -> Option<TransferStatus> {
        match event {
            LanEvent::TransferStarted { transfer_id, direction, peer, files, total_size, .. } => {
                let (verb, prep) = if *direction == Direction::Send { ("Sending", "to") } else { ("Receiving", "from") };
                let what = if files.len() == 1 { files[0].name.clone() } else { format!("{} files", files.len()) };
                let label = format!("{verb} {what} {prep} {}", peer.alias);
                self.transfers.insert(transfer_id.clone(), (label, 0, *total_size));
            }
            LanEvent::TransferProgress { transfer_id, transferred, .. } => {
                if let Some(t) = self.transfers.get_mut(transfer_id) {
                    t.1 = *transferred;
                }
                if self.last_update.is_some_and(|at| at.elapsed() < STATUS_INTERVAL) {
                    return None;
                }
            }
            LanEvent::TransferFinished { transfer_id, .. } => {
                self.transfers.remove(transfer_id);
            }
            _ => return None,
        }
        self.last_update = Some(Instant::now());
        if self.transfers.is_empty() {
            return Some(None);
        }
        let (done, total) = self.transfers.values().fold((0, 0), |(d, t), v| (d + v.1, t + v.2));
        let percent = if total == 0 { -1 } else { (done * 100 / total) as i32 };
        let title = match self.transfers.values().next() {
            Some((label, ..)) if self.transfers.len() == 1 => label.clone(),
            _ => format!("{} transfers", self.transfers.len()),
        };
        Some(Some((title, format!("{percent}%"), percent)))
    }
}

/// Applies notification updates one at a time, always the latest.
fn transfer_status_task<R: Runtime>(app: AppHandle<R>) -> tokio::sync::watch::Sender<TransferStatus> {
    let (tx, mut rx) = tokio::sync::watch::channel::<TransferStatus>(None);
    tauri::async_runtime::spawn(async move {
        while rx.changed().await.is_ok() {
            let status = rx.borrow_and_update().clone();
            let result = match &status {
                Some((title, text, percent)) => app.gs_nfc().transfer_status(true, title, text, *percent).await,
                None => app.gs_nfc().transfer_status(false, "", "", -1).await,
            };
            if let Err(err) = result {
                log::warn!("transfer notification: {err}");
            }
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;
    use globalsend_core::{device::Platform, lan::{LanPeer, protocol::FileMeta}};

    fn started(id: &str, total: u64) -> LanEvent {
        let peer = LanPeer { id: "p".into(), alias: "Pixel".into(), platform: Platform::Android, address: [127, 0, 0, 1].into(), port: 1, signaling_id: None };
        let files = vec![FileMeta { id: "0".into(), name: "a.jpg".into(), size: total, mime_type: "image/jpeg".into() }];
        LanEvent::TransferStarted { transfer_id: id.into(), direction: Direction::Send, peer, files, total_size: total, auto_accepted: false }
    }

    #[test]
    fn notification_follows_transfers_and_stops_when_done() {
        let mut active = ActiveTransfers::default();
        assert_eq!(active.apply(&started("t", 200)), Some(Some(("Sending a.jpg to Pixel".into(), "0%".into(), 0))));
        // Progress right after an update is throttled.
        let progress = LanEvent::TransferProgress { transfer_id: "t".into(), direction: Direction::Send, file_id: "0".into(), transferred: 100, total_size: 200 };
        assert_eq!(active.apply(&progress), None);
        let done = LanEvent::TransferFinished { transfer_id: "t".into(), direction: Direction::Send, ok: true, error: None };
        assert_eq!(active.apply(&done), Some(None));
    }
}
