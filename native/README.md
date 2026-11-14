# GlobalSend native app (Tauri v2)

One app for Android, iOS, Windows, macOS and Linux. The UI is the website in
`../frontend`, bundled as a static export, so it loads instantly and offline.
Heavy work (LAN discovery, transfers, background, NFC) goes in Rust.

```
native/
├─ Cargo.toml          Rust workspace
├─ crates/core/        globalsend-core: engine shared with the future CLI/TUI (no Tauri types)
│  └─ src/lan/         LAN discovery (UDP multicast) + HTTP transfers
├─ plugins/nfc/        tauri-plugin-gs-nfc: Android HCE tag + reader mode, Wi-Fi multicast lock
└─ src-tauri/          Tauri shell: window, plugins, IPC commands, mobile projects (gen/)
```

## How LAN and NFC work

- **Nearby devices:** every running app (foreground or background) multicasts a small JSON
  announcement to `224.0.0.167:53318` every 10 s and runs an HTTP server on port 53318.
  Peers drop out after 35 s of silence, or immediately when the app quits. See
  `crates/core/src/lan/protocol.rs` for the wire format.
- **Sending on LAN:** `prepare` → receiver accepts (prompt) → `upload` per file, streamed from
  disk to disk. Files land in `Downloads/GlobalSend` (falls back to the app's data folder).
- **Tap to send (Android):** the receiving phone acts as an NFC tag whenever it's unlocked
  and the app process is alive. A tap hands the sender the receiver's name, IPs, port,
  signaling id and a single-use token valid for 2 minutes. If the receiver answers on the
  LAN, files go over LAN with no prompt. Otherwise the app sends a WebRTC invite carrying the
  token, and the receiver auto-accepts it.
- **Browsers:** the same tag also answers as a standard NDEF tag with a one-time website
  link (`NEXT_PUBLIC_SITE_URL` + `/test?connectTo=…&nfcToken=…`), so Chrome on Android
  (Web NFC "Tap phone" button) or a phone without the app can tap and connect over
  WebRTC with no prompt. Without `NEXT_PUBLIC_SITE_URL` set at build time this is off.
- Windows asks for firewall access the first time the app runs. Allow **private networks**,
  otherwise other devices can't reach this PC.

```bash
cargo test -p globalsend-core   # unit + two-engine LAN tests (incl. multicast discovery)
```

The app currently opens `/test/`, the working transfer UI, until the new UI design is ready.

## Desktop (Windows)

```bash
bun install
bun run dev        # starts the Next dev server + the app with hot reload
bun run build      # static-exports the frontend and builds installers
```

## Android setup (one time)

1. Install Android Studio, then in SDK Manager install: Android SDK Platform (latest),
   SDK Platform-Tools, SDK Build-Tools, SDK Command-line Tools and **NDK (Side by side)**.
2. Set environment variables (PowerShell, then restart the terminal):
   ```powershell
   [Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
   $ndk = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\ndk" | Select-Object -Last 1
   [Environment]::SetEnvironmentVariable("NDK_HOME", $ndk.FullName, "User")
   ```
   `JAVA_HOME` (JDK 21) is already set on this machine.
3. Add the Rust Android targets:
   ```bash
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```
4. Generate the Android project (commit `src-tauri/gen/android` afterwards):
   ```bash
   bun run android:init
   ```
5. Run on a phone (USB debugging on) or emulator:
   ```bash
   bun run android:dev
   ```
   The Next dev server listens on `0.0.0.0:3000` so the phone can reach it over Wi-Fi.

iOS needs a Mac with Xcode (`tauri ios init` / `tauri ios dev`).

## Notes

- `identifier` is `com.globalsend.client`. Pick the final one before the first store
  release; changing it later makes it a different app on users' devices.
- `bun run build:tauri` in `../frontend` sets `TAURI_BUILD=1` (static export to `out/`)
  and turns off Google Analytics. The website build is unchanged.
- In frontend code, `isNativeApp()` from `lib/platform.ts` checks whether it's running inside the app.
