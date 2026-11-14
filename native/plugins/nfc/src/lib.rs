//! NFC tap-to-connect and Wi-Fi multicast lock for GlobalSend.
//!
//! Android only for now. The receiving phone emulates an NFC tag (HCE) that
//! returns a `globalsend_core::tap::TapPayload` JSON with a fresh single-use token
//! on every tap; the sending phone reads it in reader mode. Other platforms
//! report `supported: false` and every call is a no-op or an error.
//!
//! The app calls this from Rust (`app.gs_nfc()`), not from JavaScript, so
//! there are no plugin commands or permissions to configure.

use serde::{Deserialize, Serialize};
use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("NFC is not supported on this device")]
    Unsupported,
    #[error("{0}")]
    Plugin(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NfcStatus {
    /// Device has NFC hardware.
    pub supported: bool,
    /// NFC is switched on in system settings.
    pub enabled: bool,
    /// Device can act as a tag (needed to be tapped by a sender).
    pub card_emulation: bool,
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use tauri::plugin::{PluginApi, PluginHandle};

    pub struct Nfc<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TapPayloadArgs<'a> {
        template: &'a str,
        secret: &'a str,
    }

    #[derive(Deserialize)]
    struct ReadTapResponse {
        payload: String,
    }

    fn err(e: impl std::fmt::Display) -> Error {
        Error::Plugin(e.to_string())
    }

    pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(api: PluginApi<R, C>) -> Result<Nfc<R>> {
        api.register_android_plugin("com.globalsend.nfc", "NfcPlugin").map(Nfc).map_err(err)
    }

    impl<R: Runtime> Nfc<R> {
        pub fn status(&self) -> NfcStatus {
            self.0.run_mobile_plugin("status", ()).unwrap_or_default()
        }

        pub fn set_tap_payload(&self, template: &str, secret_hex: &str) -> Result<()> {
            self.0
                .run_mobile_plugin::<()>("setTapPayload", TapPayloadArgs { template, secret: secret_hex })
                .map_err(err)
        }

        pub async fn read_tap(&self) -> Result<String> {
            self.0
                .run_mobile_plugin_async::<ReadTapResponse>("readTap", ())
                .await
                .map(|r| r.payload)
                .map_err(err)
        }

        pub fn cancel_read(&self) -> Result<()> {
            self.0.run_mobile_plugin::<()>("cancelRead", ()).map_err(err)
        }

        pub fn acquire_multicast_lock(&self) -> Result<()> {
            self.0.run_mobile_plugin::<()>("acquireMulticastLock", ()).map_err(err)
        }
    }
}

#[cfg(not(target_os = "android"))]
mod fallback {
    use super::*;

    pub struct Nfc<R: Runtime>(pub std::marker::PhantomData<fn() -> R>);

    impl<R: Runtime> Nfc<R> {
        pub fn status(&self) -> NfcStatus {
            NfcStatus::default()
        }
        pub fn set_tap_payload(&self, _template: &str, _secret_hex: &str) -> Result<()> {
            Ok(())
        }
        pub async fn read_tap(&self) -> Result<String> {
            Err(Error::Unsupported)
        }
        pub fn cancel_read(&self) -> Result<()> {
            Ok(())
        }
        /// Desktop OSes deliver multicast without a lock.
        pub fn acquire_multicast_lock(&self) -> Result<()> {
            Ok(())
        }
    }
}

#[cfg(target_os = "android")]
pub use android::Nfc;
#[cfg(not(target_os = "android"))]
pub use fallback::Nfc;

/// Access the plugin from any `App`, `AppHandle` or `Window`.
pub trait NfcExt<R: Runtime> {
    fn gs_nfc(&self) -> &Nfc<R>;
}

impl<R: Runtime, T: Manager<R>> NfcExt<R> for T {
    fn gs_nfc(&self) -> &Nfc<R> {
        self.state::<Nfc<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gs-nfc")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let nfc = android::init(_api)?;
            #[cfg(not(target_os = "android"))]
            let nfc = fallback::Nfc::<R>(std::marker::PhantomData);
            app.manage(nfc);
            Ok(())
        })
        .build()
}
