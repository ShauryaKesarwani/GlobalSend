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

- [x] **Add TURN relay fallback** — optional coturn URLs and credentials are loaded from frontend environment variables; direct ICE paths remain enabled.
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
- [ ] 🟡 **Accounts / login** — optional sign-in, with favourited contacts by email for quick sending across networks.
- [ ] 🟡 **Favourite local devices** — trust selected LAN devices so their transfers are auto-accepted (skip the accept prompt); revocable in Settings.

## 📱 Native app — Tauri v2 (desktop + mobile)

> Goal: one app for Windows/macOS/Linux/Android/iOS with the same UI as the website. Features light up only where the device supports them (e.g. NFC on phones). Heavy work (discovery, transfers, background) lives in a Rust core; the webview only renders UI and receives progress.

### Architecture

- [ ] 🔴 **Shared workspace packages** — the repo is already a monorepo (`backend/`, `frontend/`); add Bun workspaces plus a `native/` (Tauri) folder and shared `packages/` (`ui`, `core`, `platform`) so code is imported instead of copied. Removes the duplicated `PeerConnectionManager.ts` / message types between frontend and backend.
- [ ] 🔴 **Shared UI package** — React + Tailwind components used by both the website and the app so they stay visually identical.
- [ ] 🔴 **Platform capability interface** — `platform.nfc?`, `platform.scanQr?`, `platform.saveFile`, `platform.onSharedFiles?` with web + Tauri implementations; UI checks availability instead of having separate apps.
- [ ] 🔴 **Rust transfer core** — discovery, transfers and background work in Rust; file bytes stream network → disk and never pass through the webview/IPC (keeps RAM flat regardless of file size).
- [ ] 🔴 **Offline-first** — UI, icons and fonts bundled in the app and loading instantly with no internet; LAN transfers work without the signaling server; degrade gracefully when the WebSocket can't be reached.
- [ ] 🟡 **Written protocol spec** — single source of truth for the TS (web) and Rust (app) engines so app ↔ website transfers interoperate.

### Transfer features

> Priority order: LAN discovery/transfer and NFC first, then background + notifications, then the rest.

- [ ] 🔴 **LAN discovery + transfer, LocalSend-compatible** — UDP multicast discovery + HTTPS transfer per the LocalSend protocol, so GlobalSend devices appear in other users' LocalSend and vice versa. Android needs a `MulticastLock` (small Kotlin plugin); iOS needs the Local Network permission + Apple's multicast entitlement.
- [ ] 🔴 **Background transfers on app switch** — Android foreground service / user-initiated data transfer job. iOS: not possible for P2P (~30 s grace only) — document the limit.
- [ ] 🔴 **Transfer progress in notification** — Android foreground-service notification with progress; iOS Live Activity (optional, only while the app may run).
- [ ] 🟡 **Internet transfers with website users** — WebRTC in Rust (`webrtc-rs`) speaking the same signaling/protocol as the web app.
- [ ] 🔴 **NFC tap to connect** — tap exchanges pairing info only, data goes over Wi-Fi. Android ↔ Android via HCE (one phone emulates a tag, custom Kotlin plugin) + reader (official `plugin-nfc`). iPhone can read only. QR stays the fallback.
- [ ] 🟡 **Quick Share interop (experimental, desktop)** — integrate `rqs_lib` from rquickshare (GPL-3.0, compatible with our AGPL-3.0), pinned to a commit, so PCs appear in Android's Quick Share. Limits: same Wi-Fi only, Samsung unreliable, may break on Google protocol changes. Android app: use the system share sheet (already includes Quick Share). iOS: not possible.
- [ ] 🟡 **Receive files shared from other apps** — native share intent / share extension (replaces the PWA `share_target`).
- [ ] 🟡 **Save received files to a user-visible location** — Tauri `fs` plugin instead of OPFS.

### Later

- [ ] 🟢 **CLI / TUI** — second binary (`globalsend-cli`, `ratatui` for TUI) shipped in the desktop installer, sharing the Rust core.
- [ ] 🐛 **Linux desktop webview** — WebKitGTK has weak WebRTC support; rely on the Rust engine there.

## 🟢 Project hygiene

- [x] **Add a `LICENSE` file** — README advertises MIT but no license file exists.
- [ ] **Tests** — no unit or integration tests. Plan calls for backend signaling/presence-expiry tests and frontend state-machine tests.
- [ ] Point README architecture section at `API_DOCS.md`.

## 🐛 Small cleanups

- [ ] `PeerConnectionManager.sendMessage` has a redundant `if/else` — both branches call `this.dc.send(data)` (`PeerConnectionManager.ts:106`).
- [ ] Backend logs full incoming messages including file names (`ws/index.ts:29`) — plan says keep logs metadata-minimal.
- [ ] Repo/product name mismatch: GitHub remote is `GlobalSend`, product is `Rift`.

---

*Keep this in sync as items land. Update `API_DOCS.md` whenever a message shape or constant changes.*
