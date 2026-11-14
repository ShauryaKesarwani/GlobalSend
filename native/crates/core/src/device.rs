//! Identity of the local device, shown to peers in discovery lists.

use serde::{Deserialize, Serialize};

/// Operating system family, reported to peers so they can pick an icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Android,
    Ios,
    Windows,
    Macos,
    Linux,
    /// Anything a newer peer reports that this build doesn't know yet.
    #[serde(other)]
    Unknown,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(target_os = "android") {
            Self::Android
        } else if cfg!(target_os = "ios") {
            Self::Ios
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Unknown
        }
    }

    pub const fn is_mobile(self) -> bool {
        matches!(self, Self::Android | Self::Ios)
    }

    const fn fallback_name(self) -> &'static str {
        match self {
            Self::Android => "Android phone",
            Self::Ios => "iPhone",
            Self::Windows => "Windows PC",
            Self::Macos => "Mac",
            Self::Linux => "Linux PC",
            Self::Unknown => "GlobalSend device",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    /// Suggested name for first startup; the user can rename it in Settings.
    pub default_name: String,
    pub platform: Platform,
    pub app_version: &'static str,
}

impl DeviceInfo {
    pub fn current() -> Self {
        let platform = Platform::current();
        Self {
            default_name: default_device_name(platform),
            platform,
            app_version: env!("CARGO_PKG_VERSION"),
        }
    }
}

/// Desktop hostnames are usually recognisable ("SHAURYA-PC"); phones don't
/// expose one to apps, so fall back to a generic platform name.
fn default_device_name(platform: Platform) -> String {
    if !platform.is_mobile() {
        for var in ["COMPUTERNAME", "HOSTNAME"] {
            if let Ok(name) = std::env::var(var) {
                let name = name.trim();
                if !name.is_empty() {
                    return name.to_owned();
                }
            }
        }
    }
    platform.fallback_name().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_name_is_never_empty() {
        assert!(!DeviceInfo::current().default_name.is_empty());
    }

    #[test]
    fn mobile_uses_platform_fallback() {
        assert_eq!(default_device_name(Platform::Android), "Android phone");
    }
}
