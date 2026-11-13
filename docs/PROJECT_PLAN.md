## Internet P2P File Transfer MVP

This plan uses your confirmed stack choices: Hono backend + WebSocket signaling, Neon for persistent metadata/session state, existing Next.js frontend in `rift/frontend`, and WebRTC DataChannels for direct file transfer. The MVP is optimized for one developer: anonymous ephemeral identities, internet-wide online presence, and online-only transfer (no offline queueing, no server-side file storage). It keeps complexity low by relying on browser-native WebRTC encryption (DTLS/SRTP), Google STUN for initial connectivity, and a TURN-ready abstraction so relay can be added without refactors. The architecture separates responsibilities clearly: signaling/presence/coordination in backend + DB, byte transfer strictly browser-to-browser.

**Architecture (High-Level)**
1. Define three planes: Control Plane (presence + signaling), Data Plane (WebRTC DataChannel file bytes), and Persistence Plane (Neon metadata only; no file blobs).
2. Use this topology text in the doc: Sender Browser ↔ Hono WebSocket (offer/answer/ICE + invite state) ↔ Receiver Browser, while file chunks flow Sender Browser ↔ Receiver Browser directly over DataChannel.
3. Capture strict rule: server handles coordination only; never accepts multipart file upload endpoints.
4. Document online-only behavior: if target disconnects before acceptance, transfer is canceled and sender retries manually.

**System Design (Frontend + Backend)**
1. Frontend (Next.js in `rift/frontend/app/page.tsx`):
   - Generate random human-readable alias on first load (e.g., adjective-animal-###) and refresh on each new session.
   - Maintain WebSocket session for presence list and signaling events.
   - Build sender state machine: idle → selecting → offering → connected → transferring → complete/failed.
   - Build receiver state machine: idle → incoming-invite → accepting/declining → connected → receiving → complete/failed.
2. Backend (new Hono service under `rift/backend`):
   - WebSocket hub for signaling and presence fan-out.
   - REST bootstrap endpoint for session token + ICE config.
   - Presence registry with heartbeat/TTL and disconnect cleanup.
   - Signaling broker for `offer`, `answer`, `ice-candidate`, `transfer-invite`, `transfer-accept`, `transfer-decline`, `transfer-cancel`.
3. Neon responsibilities:
   - Ephemeral session rows, peer metadata, optional short-lived transfer logs for debugging/abuse controls.
   - No file content columns, no chunk persistence, no blob storage.
4. Keep protocol versioned (`v1`) to allow non-breaking message evolution.

**Recommended Tech Stack**
1. Frontend: Next.js (existing), TypeScript, browser WebRTC APIs, lightweight state manager (or React state only for MVP), Zod for runtime message validation.
2. Backend: Hono + Node runtime, `ws`/WebSocket adapter, TypeScript, Zod validators, Neon Postgres driver.
3. Infra: Neon database, backend deployment on Fly/Railway/Render, environment-managed STUN list, TURN provider added when needed.
4. Observability: structured logs with correlation ID per transfer/session; minimal metrics (active peers, connect success rate, median transfer setup time).

**MVP Roadmap (Build Order)**
1. Bootstrap backend service and frontend-to-backend connectivity.
2. Implement identity generation + heartbeat-based presence list.
3. Implement signaling message contracts and routing with strict schema checks.
4. Establish WebRTC peer connection for text ping over DataChannel.
5. Add file picker + chunked send/receive with progress bars.
6. Add cancellation, timeout, and reconnect-safe cleanup.
7. Add basic abuse controls (rate limit invites, payload validation, size caps).
8. Add TURN-ready config path and production env hardening.
9. Run end-to-end manual matrix (same LAN, different NATs, mobile hotspot, firewall-restricted network).

**File Transfer Design (Chunking, Progress, Retries)**
1. Chunk strategy: fixed chunk size (start with 64 KB), adaptive downshift on backpressure.
2. Backpressure: gate sending via `bufferedAmount` thresholds; pause/resume when high/low watermark crossed.
3. Metadata handshake: sender first transmits file manifest (name, size, mime, chunk count, transfer ID, checksum algorithm).
4. Reliability: DataChannel `ordered: true` for MVP; app-level ACK every N chunks for progress accuracy.
5. Retries: if channel drops, mark transfer failed (MVP) and allow restart from zero; resumable ranges deferred to v2.
6. Integrity: verify final checksum on receiver before save prompt.
7. UX progress model: per-file % + throughput + ETA, and explicit states for waiting/connecting/transferring/verifying/completed.

**WebRTC Lifecycle**
1. Sender selects recipient and emits `transfer-invite`.
2. Receiver accepts; sender creates RTCPeerConnection + DataChannel and sends SDP offer via signaling WS.
3. Receiver sets remote description, creates answer, sends answer via WS.
4. Both peers exchange ICE candidates via WS until connected.
5. DataChannel opens; sender streams manifest then chunks.
6. Receiver writes chunks to in-memory buffer/streamed writer and confirms completion.
7. Both peers send terminal event and close PC/channel gracefully.
8. Failure paths: ICE timeout, answer timeout, channel close mid-transfer, user cancel; all must trigger UI + backend cleanup.

**Presence Design (Real-Time Online Users)**
1. Session open creates online record with alias, session ID, last-seen timestamp, and capabilities.
2. Heartbeat every 10–15s from frontend; backend expires peers after ~30–45s inactivity.
3. Broadcast diff events (`peer_join`, `peer_leave`, `peer_update`) instead of full list every tick.
4. Presence scope is global list for MVP; no rooms required.
5. Privacy baseline: expose alias + ephemeral peer ID only (no IP, no email, no device fingerprint).

**Security (Practical MVP)**
1. Enforce payload schema validation for every WS/REST message.
2. Rate limit invites/signaling per peer and per IP to reduce spam/DoS.
3. Generate unguessable session IDs; rotate on reconnect.
4. Keep logs metadata-only; never log file names if not required, never log file bytes.
5. Rely on WebRTC transport encryption for MVP; app-layer encryption optional in v2.
6. Add max file size cap and max concurrent transfers to control memory/abuse.
7. Trust boundary doc: signaling server is untrusted for file contents but trusted for session coordination.

**NAT Traversal Strategy**
1. Start with Google STUN (`stun:stun.l.google.com:19302`) for candidate discovery.
2. Detect connection failures and classify by ICE state telemetry.
3. Keep TURN config placeholders in backend ICE config response from day one.
4. Add managed TURN (e.g., Twilio/Xirsys/self-hosted coturn) once failed direct-connect rate exceeds acceptable threshold.
5. Policy: prefer direct candidates; fallback relay only when needed.

**Scaling Considerations**
1. Horizontal scale backend with stateless WS nodes + shared Neon presence/session store.
2. Use sticky sessions only if WS adapter requires; otherwise route by peer ID map in shared store.
3. Batch presence broadcasts and debounce list updates to reduce fan-out load.
4. Partition signaling channels by transfer/session IDs to minimize noisy broadcasts.
5. Add retention window for metadata logs and scheduled cleanup job.

**Proposed Folder Structure (Hono + Existing Next.js)**
1. Root docs:
   - `rift/PROJECT_PLAN.md`
2. Backend:
   - `rift/backend/src` with `server`, `ws`, `presence`, `signaling`, `validation`, `db`, `config`.
   - Suggested symbols: `createWsHub`, `PresenceService`, `SignalingRouter`, `IceConfigProvider`.
3. Frontend:
   - Keep current app in `rift/frontend/app`.
   - Add `lib/webrtc`, `lib/signaling`, `lib/presence`, `lib/transfer`, and UI components for peer list + transfer modal.
4. Shared contracts:
   - Optional `shared/protocol` package for WS event schemas to prevent drift.

**Future Improvements (v2)**
1. Optional passphrase-based app-layer encryption on top of DataChannel.
2. Resumable transfers with chunk-range reconciliation after reconnect.
3. Multi-file queueing and folder transfer support.
4. Device trust/reputation and block list.
5. Room/contacts model, authenticated identities, and transfer history UX.
6. WebTransport/WebRTC benchmarking for performance tuning.

**Verification**
- Backend unit tests for signaling and presence expiry.
- Frontend integration tests for state-machine transitions.
- Manual e2e matrix across network scenarios and file sizes (small/medium/large).
- Release gate metrics: successful connection rate, transfer completion rate, median setup time, failure taxonomy by ICE state.

**Decisions**
- Backend baseline: Hono + WebSocket + Neon (selected over Flask baseline).
- Frontend baseline: existing Next.js scaffold in `rift/frontend`.
- Encryption scope: WebRTC-native transport encryption for MVP; app-layer E2EE deferred.
- Simplicity rule: no server-side file storage, no resumable transfer in MVP, no auth required initially.
