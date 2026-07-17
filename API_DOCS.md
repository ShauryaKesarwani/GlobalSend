# Rift — System & API Reference

> A living map of every connection, message, and function in Rift as it stands today.
> Covers the **HTTP** surface, the **WebSocket signaling protocol** (frontend ↔ backend),
> the **WebRTC DataChannel protocol** (device ↔ device), and a **function reference** for
> both sides. Written so a future you — or an agent — can navigate the system without
> re-reading the whole codebase.

**Stack at a glance:** Next.js 16 / React 19 frontend · Hono + Bun WebSocket backend · WebRTC DataChannels · Zod-validated signaling · Google STUN.

---

## Table of contents

1. [The big picture](#1-the-big-picture)
2. [Identity model](#2-identity-model)
3. [Connection map](#3-connection-map)
4. [HTTP API](#4-http-api)
5. [WebSocket protocol (frontend ↔ backend)](#5-websocket-protocol-frontend--backend)
6. [WebRTC signaling flow](#6-webrtc-signaling-flow)
7. [WebRTC DataChannel protocol (device ↔ device)](#7-webrtc-datachannel-protocol-device--device)
8. [Deep links & QR pairing](#8-deep-links--qr-pairing)
9. [Function reference — Backend](#9-function-reference--backend)
10. [Function reference — Frontend](#10-function-reference--frontend)
11. [Constants & timings](#11-constants--timings)
12. [End-to-end sequence](#12-end-to-end-sequence)

---

## 1. The big picture

Rift has **three logical planes**:

| Plane | Transport | Carries | Code |
|---|---|---|---|
| **Control** | WebSocket | presence, signaling, invite handshake | `backend/src/ws`, `frontend/lib/ws.ts` |
| **Data** | WebRTC DataChannel | file manifest + binary chunks | `frontend/webrtc/PeerConnectionManager.ts` |
| **Persistence** | *(none yet)* | metadata only, planned Neon | — |

**Golden rule:** file bytes only ever travel over the Data plane (browser → browser). The backend never receives file content — there is no upload endpoint.

---

## 2. Identity model

Every browser tab generates an **ephemeral identity** on load ([`frontend/app/test/page.tsx:44`](frontend/app/test/page.tsx#L44)):

```ts
const SESSION_ID = `peer-${Math.random().toString(36).slice(2, 7)}`; // e.g. "peer-k3f9a"
const ALIAS      = `user-${Math.random().toString(36).slice(2, 5)}`; // e.g. "user-x7q"
```

- **`SESSION_ID`** — the routing key. Used as the WebSocket `?id=` query param and as the `to` / `from` address in every signaling message.
- **`ALIAS`** — a human-readable display label shown in the presence list.

Both are regenerated per session. Nothing is persisted; a peer disappears from the registry ~45s after its last heartbeat.

> ⚠️ IDs are not authenticated. Anyone who knows a peer's `SESSION_ID` can address messages to it. Rotation/abuse controls are on the roadmap.

---

## 3. Connection map

```
┌────────────────────────────┐                       ┌────────────────────────────┐
│      SENDER BROWSER         │                       │     RECEIVER BROWSER        │
│                             │                       │                             │
│  WSClient (lib/ws.ts)       │                       │  WSClient (lib/ws.ts)       │
│  PeerConnectionManager      │                       │  PeerConnectionManager      │
└──────────────┬──────────────┘                       └──────────────┬──────────────┘
               │                                                      │
               │  WebSocket  ws://host/ws?id=<SESSION_ID>             │
               │  (control plane: presence + signaling)              │
               ▼                                                      ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │                 HONO + BUN SIGNALING SERVER                        │
        │                                                                    │
        │   GET /health          → status JSON                               │
        │   GET /ws  (upgrade)   → wsRoute  (backend/src/ws/index.ts)        │
        │                                                                    │
        │   clients:  Map<sessionId, WSContext>   (ws/store.ts)              │
        │   peers:    Map<sessionId, {alias, lastSeen}>  (presence/store.ts) │
        │                                                                    │
        │   • routes offer/answer/candidate/transfer-* to `to` peer          │
        │   • broadcasts peer_joined / peer_left to everyone                 │
        │   • expires peers after 45s (presence/cleanup.ts)                  │
        └────────────────────────────────────────────────────────────────────┘
               ▲                                                      ▲
               │                                                      │
               └──────────────────────────────────────────────────────┘
                          WebRTC DataChannel  (data plane)
                     file manifest + 256 KB binary chunks
                     DIRECT browser-to-browser, server not involved
```

**Two channels, two directions:**

- **Frontend ↔ Backend** = WebSocket. Bi-directional JSON. Presence + signaling relay only.
- **Device ↔ Device** = WebRTC DataChannel. The server relays the *setup* (SDP + ICE) but not the *bytes*.

---

## 4. HTTP API

Base URL: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`). Defined in [`backend/src/index.ts`](backend/src/index.ts).

### `GET /health`

Liveness probe.

**Request:** none.

**Response** `200 application/json`:

```json
{
  "status": "ok",
  "uptime": 1234.56,
  "timestamp": "2026-07-12T10:20:30.456Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `status` | `"ok"` | always `ok` if reachable |
| `uptime` | `number` | seconds since process start (`process.uptime()`) |
| `timestamp` | `string` | ISO-8601 server time |

### `GET /ws`

WebSocket upgrade endpoint. **Not a normal HTTP call** — the client opens a WebSocket to it.

**Query params:**

| Param | Required | Meaning |
|---|---|---|
| `id` | ✅ | the client's `SESSION_ID`; becomes its routing key in `clients` |

**Connect URL example:**

```
ws://localhost:4000/ws?id=peer-k3f9a
```

Derived on the frontend by rewriting `http`→`ws` on `NEXT_PUBLIC_API_URL` ([`frontend/src/config.ts:15`](frontend/src/config.ts#L15)). See §5 for the message protocol.

---

## 5. WebSocket protocol (frontend ↔ backend)

All frames are JSON strings. Non-string frames are ignored by the server. Every inbound message is validated against a **Zod discriminated union** on `type` ([`backend/src/validation/message.ts`](backend/src/validation/message.ts)); invalid messages are logged and dropped silently.

### 5.1 Client → Server messages

Handled by the switch in [`backend/src/ws/index.ts`](backend/src/ws/index.ts).

#### `join`

Registers presence and requests the current peer list. Sent right after the socket opens (and again on every reconnect).

```json
{ "type": "join", "alias": "user-x7q" }
```

**Effects:** upserts `peers[id] = { alias, lastSeen: now }`; broadcasts `peer_joined` to all; replies to the sender with `peer_list`.

#### `heartbeat`

Keeps the peer alive. Sent every **15s** by the client.

```json
{ "type": "heartbeat" }
```

**Effect:** refreshes `peers[id].lastSeen`. Miss it for >45s and the cleanup loop evicts you.

#### `offer` / `answer` / `candidate` — WebRTC signaling relay

Pure passthrough to the addressed peer. `data` is opaque to the server (`z.any()`).

```json
{ "type": "offer",     "to": "peer-abc12", "data": { "type": "offer", "sdp": "v=0\r\no=- ..." } }
{ "type": "answer",    "to": "peer-abc12", "data": { "type": "answer", "sdp": "v=0\r\no=- ..." } }
{ "type": "candidate", "to": "peer-abc12", "data": { "candidate": "candidate:842...", "sdpMid": "0", "sdpMLineIndex": 0 } }
```

**Effect:** the server looks up `clients[to]` and forwards `{ ...msg, from: <senderId> }`. If `to` is unknown it logs a warning and drops.

#### `transfer-invite` / `transfer-accept` / `transfer-decline` — app-level handshake

The consent layer **on top of** WebRTC. An invite asks permission; acceptance triggers the WebRTC offer.

```json
{ "type": "transfer-invite",  "to": "peer-abc12",
  "file": { "name": "photo.jpg", "size": 20480, "mimeType": "image/jpeg" } }

{ "type": "transfer-accept",  "to": "peer-abc12" }
{ "type": "transfer-decline", "to": "peer-abc12" }
```

- `file` on the invite is **optional**. A `transfer-invite` *without* `file` is used internally as a **reconnect ping** — the receiver auto-accepts if it recognizes the sender from before (see [`ws.ts:180`](frontend/lib/ws.ts#L180)).
- **Effect:** relayed to `to` with `from` attached, exactly like signaling.

> **Terminology:** `transfer-invite/accept/decline` = app UX protocol. `offer/answer/candidate` = the actual WebRTC protocol. The first gates the second.

### 5.2 Server → Client messages

Two kinds: **presence broadcasts** (generated by the server) and **relayed signaling** (forwarded with `from` added).

#### `peer_list` — reply to your `join`

```json
{
  "type": "peer_list",
  "peers": [
    { "id": "peer-k3f9a", "alias": "user-x7q" },
    { "id": "peer-abc12", "alias": "user-m2p" }
  ]
}
```

> Note: the list **includes yourself**. The frontend filters out `SESSION_ID` ([`ws.ts:130`](frontend/lib/ws.ts#L130)).

#### `peer_joined` — broadcast when anyone joins

```json
{ "type": "peer_joined", "peer": { "id": "peer-abc12", "alias": "user-m2p" } }
```

#### `peer_left` — broadcast when anyone disconnects or times out

```json
{ "type": "peer_left", "id": "peer-abc12" }
```

#### Relayed signaling — `from` is added

Any `offer` / `answer` / `candidate` / `transfer-*` sent by another peer arrives with a `from` field identifying the sender:

```json
{ "type": "transfer-invite", "from": "peer-abc12",
  "file": { "name": "photo.jpg", "size": 20480, "mimeType": "image/jpeg" } }

{ "type": "offer", "from": "peer-abc12", "data": { "type": "offer", "sdp": "..." } }
```

### 5.3 Message routing summary

| `type` | Direction | Server action |
|---|---|---|
| `join` | C→S | register presence, broadcast `peer_joined`, reply `peer_list` |
| `heartbeat` | C→S | refresh `lastSeen` |
| `offer` / `answer` / `candidate` | C→S→C | relay to `to`, add `from` |
| `transfer-invite` / `-accept` / `-decline` | C→S→C | relay to `to`, add `from` |
| `peer_list` | S→C | sent to the joiner only |
| `peer_joined` / `peer_left` | S→C | broadcast to all connected clients |

---

## 6. WebRTC signaling flow

The WebSocket is only the **matchmaker**. Here's the exact handshake that upgrades two peers to a direct DataChannel. Managed by [`PeerConnectionManager`](frontend/webrtc/PeerConnectionManager.ts) and orchestrated by [`WSClient`](frontend/lib/ws.ts).

```
SENDER (A)                        SERVER                      RECEIVER (B)
   │                                                              │
   │── transfer-invite {file} ───────────────────────────────────►│   B sees popup
   │◄──────────────────────────────────── transfer-accept ────────│   B clicks Accept
   │                                                              │
 initAsSender()                                          sendTransferAccept()
 • createDataChannel                                     • getOrCreatePeer → initAsReceiver()
 • createAndSendOffer()                                  • pc.ondatachannel armed
   │                                                              │
   │── offer {sdp} ──────────────────────────────────────────────►│  handleOffer()
   │                                                              │  • setRemoteDescription
   │                                                              │  • createAnswer
   │◄──────────────────────────────────── answer {sdp} ───────────│  • setLocalDescription
 handleAnswer()                                                   │
 • setRemoteDescription                                           │
   │                                                              │
   │◄════ candidate ══════════════════════════════════════════════►│  (both directions,
   │      handleCandidate() on both sides, repeated N times        │   many candidates)
   │                                                              │
   │══════════════ DataChannel "file-transfer" OPENS ═════════════│  onOpen() fires both sides
   │                                                              │
   └────────────── file bytes flow directly, no server ───────────┘
```

**Who does what** (only the offerer creates the channel):

| Step | Sender (A) | Receiver (B) |
|---|---|---|
| Trigger | receives `transfer-accept` → `initAsSender()` | clicks Accept → `sendTransferAccept()` → `initAsReceiver()` |
| DataChannel | **creates** it (`createDataChannel`) | **waits** for it (`pc.ondatachannel`) |
| SDP | `createOffer` → send | `handleOffer` → `createAnswer` → send |
| Answer | `handleAnswer` (store remote) | — |
| ICE | `onicecandidate` → relay; `handleCandidate` | same |

> ⚠️ The DataChannel must exist **before** `createOffer()`, otherwise the channel isn't advertised in the SDP. Only the sender creates it — if both did, you'd get a sync conflict.

---

## 7. WebRTC DataChannel protocol (device ↔ device)

Once open, the channel `"file-transfer"` (`ordered: true`, `binaryType: "arraybuffer"`) carries a tiny app-level framing protocol. Defined in [`PeerConnectionManager.ts`](frontend/webrtc/PeerConnectionManager.ts).

### Frame types

The channel multiplexes **three** kinds of frames:

1. **Control message** — a string prefixed with a sentinel:
   ```
   __rift_ctrl__{"kind":"file-meta", ...}
   ```
   `CONTROL_PREFIX = "__rift_ctrl__"`. Everything after the prefix is JSON.

2. **Binary chunk** — a raw `ArrayBuffer`, up to `CHUNK_SIZE = 256 KB`. Belongs to the transfer whose `file-meta` most recently arrived.

3. **Plain string** — any string *not* starting with the prefix → surfaced via `onMessage` (used for the text-ping test path).

### Control payloads

**`file-meta`** — sent first, opens a transfer:

```json
{
  "kind": "file-meta",
  "id": "b1946ac9-...-uuid",
  "name": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 20480,
  "chunkSize": 262144,
  "chunkCount": 1
}
```

**`file-complete`** — sent after the last chunk, closes the transfer:

```json
{ "kind": "file-complete", "id": "b1946ac9-...-uuid" }
```

### Wire sequence for one file

```
A ──►  __rift_ctrl__{"kind":"file-meta", id, name, size, chunkCount, ...}
A ──►  <ArrayBuffer chunk 1>        │ B accumulates into buffers[]
A ──►  <ArrayBuffer chunk 2>        │ B fires onFileProgress each chunk
A ──►  ...                          │
A ──►  <ArrayBuffer chunk N>        │
A ──►  __rift_ctrl__{"kind":"file-complete", id}
                                    │ B assembles Blob(buffers), fires onFileComplete
```

**Receiver assembly:** chunks are pushed into an in-memory `ArrayBuffer[]`; on `file-complete` they're joined into a `Blob` and handed up as an object URL for download. *(Large files buffer in RAM today — streaming-to-disk is on the roadmap.)*

### Backpressure

The sender gates on `dc.bufferedAmount` to avoid unbounded memory ([`PeerConnectionManager.ts:282`](frontend/webrtc/PeerConnectionManager.ts#L282)):

- **High watermark** = `32 × CHUNK_SIZE` (8 MB) → pause sending.
- **Low watermark** = `16 × CHUNK_SIZE` (4 MB) → resume on `bufferedamountlow`.

---

## 8. Deep links & QR pairing

Defined in [`frontend/lib/peerDeepLink.ts`](frontend/lib/peerDeepLink.ts), rendered by [`PeerQrCode.tsx`](frontend/components/PeerQrCode.tsx).

A peer's QR / share link encodes a URL that opens `/test` and auto-invites that peer once presence loads:

```
https://<origin>/test?connectTo=peer-k3f9a&alias=user-x7q
```

| Query param | Constant | Meaning |
|---|---|---|
| `connectTo` | `CONNECT_TO_PARAM` | target peer's `SESSION_ID` to auto-connect to |
| `alias` | `CONNECT_ALIAS_PARAM` | optional display alias for nicer UX |

**Helpers:**

| Function | Signature | Purpose |
|---|---|---|
| `buildPeerConnectUrl` | `({ origin, path?="/test", peerId, alias? }) → string` | build the shareable URL |
| `getConnectPeerId` | `(URLSearchParams) → string \| null` | read `connectTo` |
| `getConnectPeerAlias` | `(URLSearchParams) → string \| null` | read `alias` |

QR is generated client-side with the `qrcode` lib (error-correction `M`, scale 6) — the link never leaves the browser to be encoded.

---

## 9. Function reference — Backend

### `backend/src/index.ts`
| Symbol | Purpose |
|---|---|
| `app` | Hono instance; mounts `/health` and `/ws` |
| `serve({ fetch, port, websocket })` | Bun server bootstrap; `PORT` env or `4000` |
| `startCleanupLoop()` | started at boot to expire dead peers |

### `backend/src/ws/index.ts`
| Symbol | Purpose |
|---|---|
| `wsRoute` | `upgradeWebSocket` handler. Reads `?id`, wires `onOpen/onMessage/onClose` |
| `onOpen` | `clients.set(id, ws)` |
| `onMessage` | JSON-parse → Zod validate → `switch(type)` (see §5.3) |
| `onClose` | `removePeer(id)` |

### `backend/src/ws/store.ts`
| Symbol | Type | Purpose |
|---|---|---|
| `clients` | `Map<string, WSContext>` | sessionId → live socket, for routing |

### `backend/src/presence/store.ts`
| Symbol | Type | Purpose |
|---|---|---|
| `peers` | `Map<string, { alias, lastSeen }>` | online registry |

### `backend/src/presence/broadcast.ts`
| Function | Signature | Purpose |
|---|---|---|
| `broadcast` | `(message: unknown) → void` | JSON-stringify and send to **every** client |

### `backend/src/presence/cleanup.ts`
| Function | Signature | Purpose |
|---|---|---|
| `removePeer` | `(id: string) → void` | delete from `peers` + `clients`; broadcast `peer_left` if it existed |
| `startCleanupLoop` | `() → void` | every **10s**, evict peers idle >**45s** (closes their socket too) |

### `backend/src/validation/message.ts`
| Symbol | Purpose |
|---|---|
| `messageSchema` | Zod discriminated union over `type`; the single source of truth for inbound shapes |

---

## 10. Function reference — Frontend

### `frontend/lib/ws.ts` — `class WSClient`

The orchestrator. Owns the socket, reconnection, and a `Map<peerId, PeerConnectionManager>`.

**Construction:** `new WSClient(sessionId, alias, handlers)` — connects immediately.

**Public API:**

| Method | Signature | Purpose |
|---|---|---|
| `sendTransferInvite` | `(to, file?) → void` | send an invite (omit `file` for a reconnect ping) |
| `sendTransferAccept` | `(to) → void` | accept + pre-create the receiver peer |
| `sendTransferDecline` | `(to) → void` | decline |
| `sendDataChannelMessage` | `(to, message: string) → void` | send a text frame over an open channel |
| `sendFile` | `(to, file: File) → Promise<void>` | stream a file to a connected peer (progress via handler) |
| `dispose` | `() → void` | tear down socket, timers, and all peer connections |
| `getSessionId` | `() → string` | this client's id |

**Key internals:**

| Method | Purpose |
|---|---|
| `connect` | opens the WS, wires `onopen/onmessage/onclose/onerror` |
| `scheduleReconnect` | exponential backoff `1s→2s→…→30s` cap |
| `handleMessage` | dispatch on incoming server messages (see §5.2) |
| `initAsSender` / `getOrCreatePeer` | create a `PeerConnectionManager` in the right role |
| `createPeerConnection` | build a peer + attach all callbacks; passes a **getter** `() => this.ws` so the peer always uses the current socket after a reconnect |
| `rememberOpenPeersForReconnect` / `restorePeerConnections` | remember open channels on drop, re-invite on reconnect (lower `sessionId` re-invites; higher waits with a 2s fallback) |
| `startHeartbeat` / `stopHeartbeat` | 15s heartbeat interval |
| `safeSend` | drops sends silently if the socket isn't open |

**`Handlers` callbacks** (the frontend UI plugs into these): `onPeerList`, `onPeerJoined`, `onPeerLeft`, `onTransferInvite`, `onTransferAccepted`, `onTransferDeclined`, `onDataChannelOpen`, `onDataChannelClose`, `onDataChannelMessage`, `onFileStart`, `onFileProgress` (`direction: "send" | "receive"`), `onFileComplete`, `onLog`, `onReconnecting?`, `onReconnected?`.

### `frontend/webrtc/PeerConnectionManager.ts` — `class PeerConnectionManager`

One instance per remote peer. Wraps `RTCPeerConnection` + `RTCDataChannel`.

**Construction:** `new PeerConnectionManager(getWs: () => WebSocket, remotePeerId: string)`

**Role entry points:**

| Method | Caller | Effect |
|---|---|---|
| `initAsSender()` | the file sender, after `transfer-accept` | creates the DataChannel, sends the offer |
| `initAsReceiver()` | the accepter | arms `ondatachannel` to await the sender's channel |

**Signal handlers** (driven by `WSClient.handleMessage`):

| Method | Signature | Effect |
|---|---|---|
| `handleOffer` | `(sdp) → Promise` | setRemote → createAnswer → setLocal → send `answer` |
| `handleAnswer` | `(sdp) → Promise` | setRemote (completes SDP exchange) |
| `handleCandidate` | `(candidate) → Promise` | `addIceCandidate` |

**Data methods:**

| Method | Signature | Effect |
|---|---|---|
| `sendMessage` | `(data: string \| ArrayBuffer) → void` | raw send if channel open |
| `sendFile` | `(file, { onProgress }?) → Promise` | manifest → chunked send w/ backpressure → complete |
| `close` | `() → void` | close channel + peer, reset state |
| `isOpen` | `() → boolean` | channel `readyState === "open"` |

**Private internals:** `createPeerConnection` (STUN config + `onicecandidate` relay + `onconnectionstatechange`), `createAndSendOffer`, `setupDataChannelListeners`, `handleDataChannelMessage` (control vs binary vs plain), `sendControlMessage`, `waitForBufferedAmountLow`.

**Callbacks:** `onMessage`, `onOpen`, `onClose`, `onFileStart`, `onFileProgress`, `onFileComplete`, `onLog`.

### `frontend/src/config.ts`
| Symbol | Purpose |
|---|---|
| `env` | typed env: `apiUrl`, `env`, `isProduction`, `enableAnalytics` |
| `wsUrl` | `apiUrl` with `http`→`ws` rewrite |

---

## 11. Constants & timings

| Constant | Value | Where | Meaning |
|---|---|---|---|
| Backend port | `4000` (or `PORT`) | `backend/src/index.ts` | signaling server |
| Heartbeat interval | **15 s** | `ws.ts` `startHeartbeat` | client → server keepalive |
| Cleanup interval | **10 s** | `cleanup.ts` | how often dead peers are swept |
| Presence TTL | **45 s** | `cleanup.ts` | idle time before eviction |
| Reconnect backoff | `1s → 30s` cap | `ws.ts` | `BACKOFF_BASE_MS`=1000, `BACKOFF_MAX_MS`=30000 |
| Reconnect fallback | **2 s** | `ws.ts` | higher-id peer waits before re-inviting |
| Chunk size | **256 KB** | `PeerConnectionManager.ts` | `CHUNK_SIZE = 256*1024` |
| Backpressure high | **8 MB** (`32×chunk`) | `PeerConnectionManager.ts` | pause threshold |
| Backpressure low | **4 MB** (`16×chunk`) | `PeerConnectionManager.ts` | resume threshold |
| Control prefix | `__rift_ctrl__` | `PeerConnectionManager.ts` | control-frame sentinel |
| STUN server | `stun:stun.l.google.com:19302` | `PeerConnectionManager.ts` | NAT traversal (no TURN yet) |
| DataChannel | `"file-transfer"`, `ordered:true` | `PeerConnectionManager.ts` | the transfer channel |

---

## 12. End-to-end sequence

One complete transfer, every hop, in order:

```
 1. A loads /test        → SESSION_ID + ALIAS generated
 2. A: WS connect ws://host/ws?id=peer-A
 3. A → S: {join, alias}          S → A: {peer_list}     (+ broadcast peer_joined)
 4. B loads /test, connects, joins → both see each other in presence
 5. A clicks "Send"      → A → S → B: {transfer-invite, file}
 6. B clicks "Accept"    → B → S → A: {transfer-accept}
 7. A: initAsSender() → createDataChannel → createOffer
        A → S → B: {offer, sdp}
 8. B: handleOffer → createAnswer
        B → S → A: {answer, sdp}
 9. A: handleAnswer                 (SDP exchange complete)
10. both: onicecandidate → {candidate} relayed → handleCandidate (repeat)
11. ICE picks a path → DataChannel "file-transfer" OPENS → onOpen both sides
12. A → B: __rift_ctrl__{file-meta}
13. A → B: <chunk> × N            (backpressure-gated; B reports progress)
14. A → B: __rift_ctrl__{file-complete}
15. B: Blob(buffers) → object URL → download prompt → onFileComplete
    ── server was never in the byte path (steps 12–15) ──
16. On WS drop: A/B auto-reconnect (backoff), re-join, and re-invite remembered
    peers to restore the DataChannel.
```

---

*Generated from the codebase as of the current session. When you change a message shape, a constant, or a handler, update the matching section here so future agents can trust this map.*
