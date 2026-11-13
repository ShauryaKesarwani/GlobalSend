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

## 🟢 Project hygiene

- [ ] **Add a `LICENSE` file** — README advertises MIT but no license file exists.
- [ ] **Tests** — no unit or integration tests. Plan calls for backend signaling/presence-expiry tests and frontend state-machine tests.
- [ ] Point README architecture section at `API_DOCS.md`.

## 🐛 Small cleanups

- [ ] `PeerConnectionManager.sendMessage` has a redundant `if/else` — both branches call `this.dc.send(data)` (`PeerConnectionManager.ts:106`).
- [ ] Backend logs full incoming messages including file names (`ws/index.ts:29`) — plan says keep logs metadata-minimal.
- [ ] Repo/product name mismatch: GitHub remote is `GlobalSend`, product is `Rift`.

---

*Keep this in sync as items land. Update `API_DOCS.md` whenever a message shape or constant changes.*
