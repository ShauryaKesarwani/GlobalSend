//! IPC commands exposed to the webview. Keep these thin: logic lives in
//! `globalsend-core`, and file bytes must never cross this boundary.

use globalsend_core::device::DeviceInfo;

#[tauri::command]
pub fn device_info() -> DeviceInfo {
    DeviceInfo::current()
}
