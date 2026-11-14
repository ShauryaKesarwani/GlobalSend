# AGENTS.md

Guide for AI coding agents working in this repo. Read this first.

## Layout

| Path | What |
|---|---|
| `backend/` | Bun + Hono signaling server (WebSocket presence, invite relay, TURN credentials). Deployed to the VPS on push to `main`. |
| `frontend/` | Next.js 16 website. `/test` is the working transfer UI until the new design lands. Also bundled as a static export into the native app. |
| `native/` | Tauri v2 app (Android first, desktop later). Rust core in `crates/core`, Android NFC plugin in `plugins/nfc`, shell in `src-tauri`. |
| `docs/` | `TODO.md`, `API_DOCS.md`, `PROJECT_PLAN.md`. |

## Read the relevant doc before you change things

- **Starting any feature or fix:** check `docs/TODO.md` for existing notes, priorities and known limits.
- **WebSocket messages, backend routes, timeouts or constants:** `docs/API_DOCS.md`.
- **Native app, LAN protocol, NFC, Android setup:** `native/README.md`. The LAN wire format is documented in `native/crates/core/src/lan/protocol.rs` and tap tokens in `native/crates/core/src/tap.rs`.
- **Next.js code:** `frontend/AGENTS.md`. This Next.js version differs from older ones; check `frontend/node_modules/next/dist/docs/` before using an API you're unsure of.
- **Product direction or architecture questions:** `docs/PROJECT_PLAN.md`.

## Keep docs in sync (same change, not later)

- **`docs/TODO.md`:** tick items you finish, add follow-ups and limitations you discover, and keep the priority markers (🔴 🟡 🟢 🐛).
- **`docs/API_DOCS.md`:** update whenever a message shape, route or constant changes.
- **Env vars:** every new or changed variable goes into `frontend/.env.example` or `backend/.env.example` with a one-line comment. Mark what production needs to change.
- **`native/README.md`:** update when native setup, protocols or platform behaviour change.

## How to write code

- Keep code simple, minimal and easy to follow.
- Prefer established libraries for common tasks when they fit.
- Avoid long abstractions and tangled control flow.
- Add tests for new behaviour when needed, and keep each one focused on the problem it covers.
- Match the style of the surrounding code.

## Rules that are easy to break

- **The server never handles file bytes.** No upload endpoints in `backend/`.
- **Never send client IP addresses to other clients.** Only the `nearby` boolean (see `backend/src/presence/network.ts`).
- **Native app:** file bytes never cross the Tauri IPC boundary; the Rust engine streams disk ↔ network. The webview only gets progress events.
- **NFC tokens:** the Kotlin code (`plugins/nfc/.../TapProtocol.kt`) must stay byte-compatible with `tap.rs`. Both files carry the same test vector, so change them together.
- **Platform-specific features** (NFC, LAN) light up only where the device supports them. Check availability (`isNativeApp()`, `isWebNfcSupported()`, `nfc.supported`) instead of forking the UI.

## Checks

```bash
cd backend && bun test
cd frontend && bun test && bunx tsc --noEmit && bunx eslint .
cd native && cargo test -p globalsend-core && cargo build -p globalsend-app
cd native && cargo check -p globalsend-app --target aarch64-linux-android   # Android Rust paths
```

Kotlin in `native/plugins/nfc/android` only compiles inside an Android build (`bun run android:build` in `native/`), which needs the Android SDK and NDK.
