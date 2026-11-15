# Rift — TODO / Remaining Work

> Snapshot of what's built vs. what's left, compiled from a full pass over the codebase.
> This file is gitignored — it's a personal working scratchpad, not a public roadmap
> (the public roadmap lives in `README.md`).

Legend: 🔴 high priority · 🟡 medium · 🟢 nice-to-have · 🐛 bug/cleanup

---

## 🔴 Performance & core transfer

- [x] **Fix slow transfer throughput** — added bounded sender read-ahead, negotiated SCTP-safe message sizing, and fixed 8 MB/4 MB watermarks. Validate with browser throughput measurements.
- [x] **Remove the 25 MB file-size cap** — the test route no longer rejects large files.
- [x] **Stream received files to disk** — use File System Access API when available, with the Blob fallback for unsupported browsers.
- [x] **Parallelism / pipelining** — sender now keeps up to four chunk reads in flight; multiple DataChannels remain unevaluated.

## 🔴 Connectivity / NAT traversal

- [x] **Add TURN relay fallback** — TURN credentials come from the backend (`/api/ice-servers`, Cloudflare). One lookup is shared by all shards and cached; it gives up after 3 s and falls back to STUN, so LAN/offline connections never wait on it (`frontend/webrtc/iceConfig.ts`).
- [ ] **ICE failure telemetry** — classify and surface connection failures by ICE state so it's clear when TURN would have helped.

## 🟡 Reliability & integrity

- [ ] **Checksum verification** — the manifest already reserves the idea, but no checksum is computed or verified. Hash on send, verify on receive before the save prompt. Today a truncated transfer only logs a warning (`PeerConnectionManager.ts:244`).
- [ ] **Resumable transfers** — on a drop, transfers restart from zero. Add chunk-range reconciliation after reconnect.
- [ ] **Folder transfers** and richer multi-file queueing (files currently sent strictly sequentially, `page.tsx:328`).

## 🟡 Security & abuse controls

- [ ] **App-layer E2E encryption** — optional passphrase-based encryption on top of DTLS.
- [ ] **Rate limiting** on invites/signaling per peer and per IP — none exists today.
- [ ] **Payload size caps** and max concurrent transfers on the backend.
- [ ] **Session ID rotation / unguessable IDs** — IDs are short `Math.random` strings (`page.tsx:44`) and unauthenticated; anyone who knows an ID can address it.

## 🟡 Persistence & backend

- [ ] **Neon Postgres integration** — the plan calls for ephemeral session/metadata rows; nothing is wired up. Backend is fully in-memory (`clients`, `peers` maps).
- [ ] **ICE config endpoint** — REST bootstrap for session token + ICE servers (mentioned in plan, not built).
- [ ] Remove the commented-out `all_peers` endpoint stub in `backend/src/index.ts:22`.

## 🟢 Product / UX

- [ ] **Real production UI** — the functional surface is `/test` ("Transfer Test Lab"); the landing page (`app/page.tsx`) just links to it. Promote the transfer flow to a real `/` experience.
- [ ] **Human-readable aliases** — plan wants `adjective-animal-###`; code uses `user-xxx` (`page.tsx:45`).
- [ ] **Rooms / contacts** model and transfer history.
- [ ] 🔴 **Device naming** — let users set their device name on first startup and change it later in Settings, so devices are easy to recognise in discovery lists (web + app).
  - [x] Native app: first-run prompt + rename, saved in `settings.json`, advertised on LAN/NFC (`native/crates/core/src/settings.rs`, `components/NativePanel.tsx`).
  - [ ] Website: still a random `user-xxx` alias; the app should also use its device name as the signaling alias.
- [ ] 🟡 **Accounts / login** — optional sign-in, with favourited contacts by email for quick sending across networks.
- [ ] 🟡 **Favourite local devices** — trust selected LAN devices so their transfers are auto-accepted (skip the accept prompt); revocable in Settings. Needs device keys first (a device id alone is spoofable on a LAN) — pair the key on first NFC tap/accept.

## 📱 Native app — Tauri v2 (desktop + mobile)

> Goal: one app for Windows/macOS/Linux/Android/iOS with the same UI as the website. Features light up only where the device supports them (e.g. NFC on phones). Heavy work (discovery, transfers, background) lives in a Rust core; the webview only renders UI and receives progress.

### Architecture

- [ ] 🔴 **Shared workspace packages** — the repo is already a monorepo (`backend/`, `frontend/`); add Bun workspaces plus a `native/` (Tauri) folder and shared `packages/` (`ui`, `core`, `platform`) so code is imported instead of copied. Removes the duplicated `PeerConnectionManager.ts` / message types between frontend and backend.
- [ ] 🔴 **Shared UI package** — React + Tailwind components used by both the website and the app so they stay visually identical.
- [ ] 🔴 **Platform capability interface** — `platform.nfc?`, `platform.scanQr?`, `platform.saveFile`, `platform.onSharedFiles?` with web + Tauri implementations; UI checks availability instead of having separate apps.
- [x] 🔴 **Tauri v2 shell** — `native/` with Cargo workspace (`crates/core`, `src-tauri`, `plugins/nfc`), bundled static export of the frontend, desktop build verified on Windows.
- [ ] 🔴 **Rust transfer core** — discovery, transfers and background work in Rust; file bytes stream network → disk and never pass through the webview/IPC (keeps RAM flat regardless of file size). LAN part done (`globalsend-core::lan`); background work pending.
- [ ] 🔴 **Offline-first** — UI, icons and fonts bundled in the app and loading instantly with no internet; LAN transfers work without the signaling server; degrade gracefully when the WebSocket can't be reached.
- [ ] 🟡 **Written protocol spec** — single source of truth for the TS (web) and Rust (app) engines so app ↔ website transfers interoperate.

### Transfer features

> Priority order: LAN discovery/transfer and NFC first, then background + notifications, then the rest.

- [x] 🔴 **LAN discovery + transfer (GlobalSend protocol v1)** — UDP multicast `224.0.0.167:53318` + HTTP on port 53318 (`native/crates/core/src/lan/`). Devices with the app open or in the background appear under "Nearby"; prompt to accept, streaming to `Downloads/GlobalSend`, no overwrite, cancel. Website peers that are also on the LAN are listed under Nearby instead. Android `MulticastLock` in `plugins/nfc`. Covered by `crates/core/tests/lan.rs`.
  - [x] 🐛 Fixed: app crashed on LAN send (`tokio::spawn` from a sync command on the main thread); the engine now spawns on its own runtime handle. Regression test in `tests/lan.rs`.
  - [x] Nearby/tap "Send" uses the files already selected in the page (streamed in 1 MiB chunks over IPC) instead of opening a second picker.
  - [x] 🐛 Fixed: phone → PC stalled at 0%. Android IPC is text-only, so raw chunks were rejected; chunks are now base64 and a failed push cancels the transfer.
  - [x] Android: received files move to public `Download/GlobalSend` (MediaStore, Android 10+) so they appear in Files/Photos.
  - [x] **File references instead of browser files** in the app: the picker (Photos/videos, Any files) and desktop drag-and-drop give real paths / `content://` URIs (`NativeFile`, `lib/sendableFile.ts`). LAN sends read them from disk in Rust (no page, no base64). WebRTC sends read 4 MB ranges from a loopback-only, token-protected endpoint (`/local/files/{id}`). Browser `File`s still work (base64 fallback). Approach checked against LocalSend, which also reads content URIs by file descriptor.
  - [x] Android receives straight into public `Download/GlobalSend` (Android 11+, like LocalSend) and the media scanner indexes it; older versions copy via MediaStore.
  - [x] Transfer speed shown (live, then average).
  - [ ] 🔴 Verify on the Pixel: phone ↔ PC speed with native picks, background transfer with the screen off, files visible in Files/Photos.
  - [ ] 🔴 Release builds: Android blocks cleartext HTTP from the webview, which the loopback file endpoint (`http://127.0.0.1`) needs. Add a network security config allowing cleartext to 127.0.0.1 only.
  - [ ] 🟡 Speed: parallel uploads per transfer (LocalSend allows it), tune read/write buffer sizes, measure against LocalSend on the same Wi-Fi.
  - [ ] 🟡 "Open" / "Show in folder" buttons for received files (opener plugin).
  - [ ] 🟢 `tauri android dev` with Next.js: the page loads via tauri.localhost and hot reload fails; scripts didn't run when assets were served from the dev host (`assetPrefix`, reverted). Use APK builds for now.
  - [ ] 🔴 Test on two real phones + a PC on the same Wi-Fi (Windows asks for firewall access on first launch — allow private networks).
  - [ ] 🟡 Encrypt LAN traffic: HTTPS with self-signed certs pinned via the announcement (currently plain HTTP).
  - [x] **Browser "Nearby"** — browsers can't multicast or run a server, so the signaling server marks peers on the same network (public IPv4 / IPv6 /64, never sent to clients) with `nearby: true`; the page shows a Nearby badge and lists them first, and WebRTC connects them directly over the LAN. Needs internet. `backend/src/presence/network.ts`.
  - [ ] 🔴 Production: set `NODE_ENV=production` and `TRUST_PROXY=1` (Caddy on the Oracle VPS) on the backend — see `backend/.env.example`. Set `NEXT_PUBLIC_SITE_URL` for the app build — see `frontend/.env.example`.
  - Browser limits (by design, not fixing): needs internet to reach the signaling server; two tabs on one PC with Wi-Fi off can't connect (browsers never use loopback for WebRTC). Use the native app for offline LAN. Over plain `http://<LAN IP>` (local testing) browsers also disable secure-context APIs: `crypto.randomUUID` (now polyfilled in `lib/randomId.ts`), disk staging for big received files (falls back to RAM), clipboard and the service worker. Use HTTPS (deployed site or Tailscale Funnel) for real use.
  - [ ] 🟢 Offline browser LAN (Snapdrop-style): the native app could serve the web UI + signaling on the LAN so browsers on the same Wi-Fi work without internet.
  - [ ] 🟡 iOS: Local Network usage string + multicast entitlement request to Apple.
  - [ ] 🟡 **LocalSend compatibility** — second listener on `224.0.0.167:53317` speaking LocalSend v2 (HTTPS), so we show up in LocalSend and vice versa. Protocol shape already mirrors it.
- [ ] 🟡 **No shared network at all** — LAN needs the same Wi-Fi or a hotspot (works without internet). Phone ↔ phone with no network would need Wi-Fi Direct / Wi-Fi Aware or Bluetooth (Android only; custom plugin).
- [x] 🔴 **Background transfers on app switch** — Android `dataSync` foreground service (`TransferService`) runs only while a transfer is active, with a partial wake lock and a low-latency Wi-Fi lock, as LocalSend does. iOS: not possible for P2P (~30 s grace only).
- [x] 🔴 **Transfer progress in notification** — the same service shows "Sending X to Y · N%", updated once a second. Asks for notification permission on Android 13+. iOS Live Activity: optional, later.
- [x] 🔴 **Always-on presence, KDE Connect style (first step)** — "Stay reachable in background" toggle (Android, off by default, saved in settings): `TransferService` runs as a `connectedDevice` foreground service with a quiet ongoing notification and no wake/Wi-Fi locks while idle.
  - [ ] 🟡 Lower idle cost further: longer announce interval when idle, pause on battery saver / when not on Wi-Fi, start on boot (optional).
  - [ ] 🟡 Check KDE Connect's approach (its sources didn't load for research).
- [x] 🔴 **Accept from a notification** — Android: heads-up "X wants to send you …" with Accept / Decline buttons when the app isn't on screen; button presses reach Rust through a long-poll, so they work without the page. Windows/desktop: notification + taskbar flash when the window isn't focused; accept in the app window.
  - [ ] 🟡 Desktop: Accept/Decline buttons in the Windows toast (needs a toast with actions; tauri-plugin-notification has none on desktop), and a tray icon so closing the window keeps the app reachable.
- [ ] 🟡 **Internet transfers with website users** — WebRTC in Rust (`webrtc-rs`) speaking the same signaling/protocol as the web app.
- [ ] 🔴 **NFC tap to connect** — tap exchanges pairing info only, data goes over Wi-Fi. Android ↔ Android via HCE (one phone emulates a tag, custom Kotlin plugin) + reader (official `plugin-nfc`). iPhone can read only. QR stays the fallback.
  - [x] Implemented (untested on hardware): receiver's HCE service (`plugins/nfc/android`) returns name/IPs/port/signaling id + a single-use HMAC token (2 min); sender reads it in reader mode. Same LAN → LAN transfer with no accept prompt; otherwise WebRTC invite carrying `nfcToken`, auto-accepted after `verify_tap_token`. Locked phones don't answer.
  - [x] Android debug APK builds; NFC plugin Kotlin compiles and its HCE service is in the merged manifest.
  - [ ] 🔴 Test phone ↔ phone on hardware (Pixel 7 + second phone).
  - [ ] 🟡 iPhone as sender: Core NFC ISO 7816 reader for AID `F0474C53454E4401` (needs Mac + entitlement).
  - [x] **Browser tap (Web NFC, Chrome on Android)** — the app's HCE service also emulates a standard NFC Type 4 NDEF tag holding a one-time link `…/test?connectTo=<ws>&alias=…&nfcToken=…`. The website's "Tap phone (NFC)" button reads it and sends a WebRTC invite with the token, so the app auto-accepts. Phones without the app or site open just open the link and connect the same way. Browsers can only read, not be tapped. Needs `NEXT_PUBLIC_SITE_URL` in the app build and the receiver online.
  - [ ] 🔴 Test Web NFC + "no app" tap on real phones (Kotlin still uncompiled). If another installed app also emulates NDEF, Android may ask which one to use.
  - [ ] 🟡 Two app phones touched without "Tap to send" pressed: one may open the website link in its browser. Consider foreground dispatch in the app to swallow it.
- [ ] 🟡 **Quick Share interop (experimental, desktop)** — integrate `rqs_lib` from rquickshare (GPL-3.0, compatible with our AGPL-3.0), pinned to a commit, so PCs appear in Android's Quick Share. Limits: same Wi-Fi only, Samsung unreliable, may break on Google protocol changes. Android app: use the system share sheet (already includes Quick Share). iOS: not possible.
- [ ] 🔴 **Android share menu** — "Share → GlobalSend" from any app (`ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent filter); hands `content://` URIs to the page as `NativeFile`s. Replaces the PWA `share_target` in the app.
- [ ] 🟡 **Android drag-and-drop** (Android 13+, e.g. split screen / desktop mode): accept dropped `content://` URIs (`DragEvent` + `requestDragAndDropPermissions`).
- [ ] 🟢 **iPhone drag-and-drop / share extension** — optional, once iOS work starts (needs a Mac).
- [ ] 🟡 **Windows "Send with GlobalSend"** — Explorer context menu entry and file-select launch (`globalsend.exe --send <paths>`), via the installer (NSIS/MSI registry keys) and the single-instance plugin so a running app receives the paths.
- [x] 🟡 **Save received files to a user-visible location** — desktop `Downloads/GlobalSend`, Android public `Download/GlobalSend`.

### Later

- [ ] 🟢 **CLI / TUI** — second binary (`globalsend-cli`, `ratatui` for TUI) shipped in the desktop installer, sharing the Rust core.
- [ ] 🐛 **Linux desktop webview** — WebKitGTK has weak WebRTC support; rely on the Rust engine there.

## 🟢 Project hygiene

- [x] **Agent guide** — root `AGENTS.md` (docs to read, TODO/API/env upkeep, code style, checks); `CLAUDE.md` imports it.
- [x] **Env samples** — `frontend/.env.example` (now tracked in git) and `backend/.env.example`, with production notes marked `[CHANGED]`.
- [x] **Add a `LICENSE` file** — README advertises MIT but no license file exists.
- [ ] **Tests** — no unit or integration tests. Plan calls for backend signaling/presence-expiry tests and frontend state-machine tests.
- [ ] Point README architecture section at `API_DOCS.md`.

## 🐛 Small cleanups

- [ ] `PeerConnectionManager.sendMessage` has a redundant `if/else` — both branches call `this.dc.send(data)` (`PeerConnectionManager.ts:106`).
- [ ] Backend logs full incoming messages including file names (`ws/index.ts:29`) — plan says keep logs metadata-minimal.
- [ ] Repo/product name mismatch: GitHub remote is `GlobalSend`, product is `Rift`.

---

*Keep this in sync as items land. Update `API_DOCS.md` whenever a message shape or constant changes.*
