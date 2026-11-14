mod commands;
mod native;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(if cfg!(debug_assertions) { log::LevelFilter::Info } else { log::LevelFilter::Warn })
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_gs_nfc::init())
        .setup(|app| {
            let state = tauri::async_runtime::block_on(native::NativeState::start(app.handle()))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::device_info,
            commands::app_settings,
            commands::set_device_name,
            commands::set_signaling_id,
            commands::lan_peers,
            commands::lan_refresh,
            commands::lan_send,
            commands::lan_respond,
            commands::lan_cancel,
            commands::nfc_read_tap,
            commands::nfc_cancel_read,
            commands::verify_tap_token,
        ])
        .build(tauri::generate_context!())
        .expect("error while building GlobalSend")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<native::NativeState>() {
                    // Tell LAN peers we're gone so we disappear from their lists at once.
                    tauri::async_runtime::block_on(state.engine.shutdown());
                }
            }
        });
}
