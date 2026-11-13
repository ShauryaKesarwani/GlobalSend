// Runtime detection for the native (Tauri) app vs. the website. Grows into the
// platform capability interface (NFC, LAN, share intents) tracked in docs/TODO.md.
export function isNativeApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
