//! GlobalSend core engine.
//!
//! Everything here must stay free of Tauri/UI types so the same crate can back
//! the desktop + mobile app and the future CLI/TUI binaries.

pub mod device;
pub mod lan;
pub mod settings;
pub mod tap;
