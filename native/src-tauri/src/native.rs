//! Long-lived native state: settings, the LAN engine and the NFC tag payload.

use std::{path::PathBuf, sync::{Arc, Mutex}, time::Duration};

use globalsend_core::{
    device::DeviceInfo,
    lan::{LanConfig, LanEngine},
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
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                if let Err(err) = emitter.emit(LAN_EVENT, &event) {
                    log::warn!("could not forward LAN event: {err}");
                }
            }
        });

        let state = Self { engine, tap, settings: Mutex::new(settings), settings_path, download_dir };
        state.sync_tap_payload(app);

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

/// Downloads/GlobalSend when writable, otherwise the app's own data folder.
fn pick_download_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let fallback = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("received");
    let Ok(downloads) = app.path().download_dir() else { return fallback };
    let preferred = downloads.join("GlobalSend");
    let probe = preferred.join(".globalsend-write-test");
    let writable = std::fs::create_dir_all(&preferred).is_ok() && std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    if writable { preferred } else { fallback }
}
