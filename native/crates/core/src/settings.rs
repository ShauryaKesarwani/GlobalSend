//! Persistent per-install settings (device identity and name).

use std::{fs, io, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Stable random id for this install; peers use it to recognise the device.
    pub device_id: String,
    /// Name shown to other devices. `None` until the user picks one on first startup.
    #[serde(default)]
    pub device_name: Option<String>,
    /// Android: whether to keep running when the app is closed.
    #[serde(default)]
    pub background_mode: BackgroundMode,
    /// Accept transfers started by an NFC tap without asking.
    #[serde(default = "yes")]
    pub nfc_auto_accept: bool,
    /// Accept every transfer from the local network without asking.
    #[serde(default)]
    pub lan_auto_accept: bool,
    /// Where received files go; `None` means the platform default.
    #[serde(default)]
    pub download_dir: Option<String>,
}

fn yes() -> bool {
    true
}

/// Android background behaviour (desktop apps simply keep running).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundMode {
    /// Only while the app is open (transfers in progress still finish).
    #[default]
    Off,
    /// Foreground service with a quiet notification; the phone may doze between packets.
    Reachable,
    /// Like `Reachable`, plus wake and Wi-Fi locks so it answers instantly. Uses more battery.
    AlwaysAwake,
}

impl Settings {
    fn fresh() -> Self {
        Self {
            device_id: uuid::Uuid::new_v4().to_string(),
            device_name: None,
            background_mode: BackgroundMode::Off,
            nfc_auto_accept: true,
            lan_auto_accept: false,
            download_dir: None,
        }
    }

    /// Loads settings from `path`, creating (and saving) new ones if missing or unreadable.
    pub fn load_or_create(path: &Path) -> io::Result<Self> {
        if let Ok(raw) = fs::read(path) {
            match serde_json::from_slice::<Self>(&raw) {
                Ok(settings) if !settings.device_id.is_empty() => return Ok(settings),
                _ => log::warn!("settings at {} are unreadable; starting fresh", path.display()),
            }
        }
        let settings = Self::fresh();
        settings.save(path)?;
        Ok(settings)
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        fs::rename(tmp, path)
    }
}

/// Trims a user-entered device name, drops control characters and caps it at 40 characters.
pub fn normalize_device_name(name: &str) -> Option<String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    let name = name.trim().to_owned();
    (!name.is_empty()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_then_reloads_same_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let first = Settings::load_or_create(&path).unwrap();
        let mut second = Settings::load_or_create(&path).unwrap();
        assert_eq!(first.device_id, second.device_id);
        second.device_name = Some("Desk".into());
        second.save(&path).unwrap();
        assert_eq!(Settings::load_or_create(&path).unwrap().device_name.as_deref(), Some("Desk"));
    }

    #[test]
    fn old_settings_files_get_safe_defaults() {
        let old: Settings = serde_json::from_str(r#"{"deviceId":"abc","stayReachable":true}"#).unwrap();
        assert_eq!(old.background_mode, BackgroundMode::Off);
        assert!(old.nfc_auto_accept);
        assert!(!old.lan_auto_accept);
        assert_eq!(old.download_dir, None);
    }

    #[test]
    fn normalizes_names() {
        assert_eq!(normalize_device_name("  Phone\n "), Some("Phone".into()));
        assert_eq!(normalize_device_name("   "), None);
        assert_eq!(normalize_device_name(&"x".repeat(80)).unwrap().chars().count(), 40);
    }
}
