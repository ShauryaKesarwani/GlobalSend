<div align="center">

# 🌐 GlobalSend

### Peer‑to‑peer file transfer that works across the internet — right from your browser.

No installs. No accounts. No files touching a server. Just open a tab, pick a peer, and send.

<br />

[![Status](https://img.shields.io/badge/status-active%20development-f59e0b?style=for-the-badge)](#-roadmap)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge)](#-license)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-6366f1?style=for-the-badge)](#-contributing)

<br />

![WebRTC](https://img.shields.io/badge/WebRTC-P2P-333333?style=flat-square&logo=webrtc&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js%2016-000000?style=flat-square&logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React%2019-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20v4-38BDF8?style=flat-square&logo=tailwindcss&logoColor=white)
![Hono](https://img.shields.io/badge/Hono-E36002?style=flat-square&logo=hono&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white)
![Zod](https://img.shields.io/badge/Zod-3E67B1?style=flat-square&logo=zod&logoColor=white)

</div>

---

## ✨ What is GlobalSend?

**GlobalSend** is an open‑source peer-to-peer technology ecosystem. Its first product is browser-to-browser file transfer: two people open the app, see each other in a live presence list, and send files **directly** to one another over an encrypted [WebRTC](https://webrtc.org/) DataChannel.

The key idea: **your file bytes never travel through our servers.** The backend only helps two browsers find each other and shake hands (signaling + presence). Once the connection is established, the server steps out of the way and bytes flow peer‑to‑peer.

> Think **AirDrop for the whole internet**, running entirely in a browser tab — no app to install, works beyond your local network.

### Why it's nice

- 🌍 **Works across the internet**, not just your LAN — unlike most local‑network tools.
- 🖥️ **Zero install** — it's a web app. Open it on a phone, a work laptop, a locked‑down machine.
- 🔒 **Bytes stay private** — files go browser‑to‑browser over WebRTC's built‑in DTLS encryption. The server literally never sees them.
- 📷 **QR + deep‑link pairing** — scan a code from another device to auto‑connect.
- ⚡ **Fast** — bounded read-ahead and backpressure keep the DataChannel fed without unbounded sender memory.

---

## 🔁 How it works

```
        ┌─────────────────────────────────────────────────────────┐
        │            SIGNALING (Hono + WebSocket)                 │
        │   presence · offer / answer · ICE · invite handshake    │
        └───────────────▲──────────────────────────▲──────────────┘
                        │                          │
             control plane only          control plane only
                        │                          │
                 ┌──────┴──────┐            ┌──────┴──────┐
                 │   Sender    │            │  Receiver   │
                 │   Browser   │            │   Browser   │
                 └──────┬──────┘            └──────┬──────┘
                        │                          │
                        └──────────────────────────┘
                  WebRTC DataChannel shards (encrypted)
                    file bytes, direct P2P, striped
```

The transfer lifecycle, one line per step:

1. **A** clicks *Send* → app sends a `transfer-invite` over the WebSocket.
2. **B** sees a popup, clicks *Accept* → app sends `transfer-accept`.
3. **A** creates several `RTCPeerConnection`/`RTCDataChannel` shards, builds SDP **offers**, and relays them via the server.
4. **B** answers each shard; both sides exchange **ICE candidates** through the server.
5. The browser picks the best network paths → the **DataChannel shards open**.
6. **A** stripes indexed chunks across the active shards. **B** reassembles them in order. **The server is now out of the loop.**

---

## 🎯 Current features

| | Feature | Notes |
|---|---|---|
| ✅ | **Internet‑wide P2P transfer** | WebRTC DataChannels with configurable STUN/TURN |
| ✅ | **Live presence list** | See who's online in real time via WebSocket heartbeats |
| ✅ | **Invite / accept handshake** | Consent‑based — nothing sends until the receiver accepts |
| ✅ | **Multiple‑file transfers** | Queue and send several files in one session |
| ✅ | **QR code + deep‑link pairing** | Scan from a second device to auto‑connect to a peer |
| ✅ | **Chunked streaming with backpressure** | 64 KB chunks, `bufferedAmount` high/low watermarks |
| ✅ | **Live progress** | Per‑file transferred / total bytes, both send and receive |
| ✅ | **Reconnection resilience** | WebSocket auto‑reconnects with exponential backoff and restores in‑flight peer connections |
| ✅ | **Ephemeral anonymous identity** | Random session ID + alias generated per tab — no sign‑up, nothing stored |
| ✅ | **Schema‑validated signaling** | Every WebSocket message is Zod‑validated on the backend |

---

## 🆚 How GlobalSend file transfer compares

|  | **🌐 GlobalSend** | **[LocalSend](https://localsend.org/)** | **[Magic Wormhole](https://github.com/magic-wormhole/magic-wormhole)** |
|---|:---:|:---:|:---:|
| **Install required** | ❌ None (web app) | ✅ Native app per OS | ✅ CLI / Python |
| **Works across the internet** | ✅ Yes | ❌ LAN only | ✅ Yes |
| **Direct P2P data path** | ✅ WebRTC | ✅ Local socket | ⚠️ Via transit relay |
| **Runs in a browser** | ✅ Yes | ❌ No | ❌ No |
| **Pairing** | Presence list + QR/link | Auto‑discovery on LAN | Short code phrase |
| **Encryption** | ✅ WebRTC DTLS | ✅ TLS | ✅ End‑to‑end (SPAKE2) |
| **No server sees your files** | ✅ Yes | ✅ Yes | ⚠️ Encrypted, but relayed |
| **Mobile ↔ desktop** | ✅ Any browser | ✅ With apps | ⚠️ Terminal‑bound |

**Where each shines:**

- **LocalSend** is fantastic for the same Wi‑Fi network and gives you polished native apps — but it can't reach a friend across the country. GlobalSend file transfer is designed to work *beyond* the LAN.
- **Magic Wormhole** is a brilliant, battle‑tested CLI with strong end‑to‑end crypto, but it's terminal‑bound and routes data through a transit relay when a direct connection fails. GlobalSend aims for a direct browser‑to‑browser path and a zero‑friction, no‑install UX.
- **GlobalSend** brings file transfers to any modern browser, with nothing to install and support for sending over the internet.

> 💡 GlobalSend's WebRTC handshake and chunking approach draw inspiration from **LocalSend's** open implementation — huge thanks to that project (see [Credits](#-credits)).

---

## 🗺️ Roadmap

Planned and in‑progress work:

- 🔐 **Optional passphrase‑based app‑layer E2E encryption** on top of the DataChannel
- ♻️ **Resumable transfers** with chunk‑range reconciliation after a drop
- 📁 **Folder transfers** and richer multi‑file queueing
- 🔀 **TURN relay fallback** for the strictest NATs and firewalls (optional coturn configuration)
- 💾 **Streaming to disk** via the File System Access API (Blob fallback remains for unsupported browsers)
- 🧾 **Integrity verification** — end‑to‑end checksum before the save prompt
- 🛡️ **Abuse controls** — invite rate limiting and payload size caps
- 🚪 **Rooms / contacts** and optional transfer history

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the full design document.

---

## 🏗️ Architecture

The GlobalSend file-transfer product is split into three planes:

- **Control plane** — presence + signaling, over WebSocket (`backend`)
- **Data plane** — the actual file bytes, strictly browser‑to‑browser over WebRTC (`frontend`)
- **Persistence plane** — metadata only; **never** file blobs *(planned: Neon Postgres)*

```
globalsend/
├── backend/                 # Hono + Bun WebSocket signaling server
│   └── src/
│       ├── index.ts         # HTTP + WS entrypoint, /health, /ws
│       ├── ws/              # WebSocket route + client registry
│       ├── presence/        # online store, heartbeat cleanup, broadcast
│       ├── validation/      # Zod schemas for every message
│       ├── types/           # shared message contracts
│       └── webrtc/          # signaling helpers
│
└── frontend/                # Next.js 16 + React 19 + Tailwind v4
    ├── app/
    │   ├── page.tsx         # landing
    │   └── test/page.tsx    # the transfer surface (presence, invites, progress)
    ├── webrtc/
    │   └── PeerConnectionManager.ts  # RTCPeerConnection + DataChannel + chunking
    ├── lib/
    │   ├── ws.ts            # WSClient: signaling, reconnection, peer orchestration
    │   └── peerDeepLink.ts  # QR / shareable connect links
    └── components/
        └── PeerQrCode.tsx   # QR generation + copy link
```

**Design rules baked in:**

- The signaling server handles coordination only — there are **no file‑upload endpoints**, ever.
- Presence is ephemeral: peers expire ~45s after their last heartbeat.
- Every inbound WebSocket message is schema‑validated before it's acted on.

---

## 🧰 Tech stack

**Frontend** — Next.js 16 · React 19 · TypeScript · Tailwind CSS v4 · browser WebRTC APIs · `qrcode`

**Backend** — Hono · Bun runtime · native WebSocket · Zod · TypeScript

**Connectivity** — multiple STUN/TURN candidates plus configurable parallel WebRTC connections

---

## 🚀 Getting started (self‑hosting)

GlobalSend file transfer is designed to be self‑hosted — run your own signaling backend and frontend. You'll need [**Bun**](https://bun.sh/) installed.

### 1. Clone

```sh
git clone https://github.com/ShauryaKesarwani/GlobalSend.git globalsend
cd globalsend
```

### 2. Run the backend (signaling server)

```sh
cd backend
bun install
bun run dev
```

The server starts on **http://localhost:4000** (`/health` for a status check, `/ws` for signaling). Override the port with the `PORT` env var.

### 3. Run the frontend

In a second terminal:

```sh
cd frontend
bun install
bun run dev
```

Open the app, head to **`/test`**, and you'll get a session alias and a QR code. Open a second tab (or scan the QR from another device) to see the peer appear — then send a file.

### 4. Configure the frontend

Create `frontend/.env.local`:

```sh
# Where the signaling backend lives (ws:// is derived automatically)
NEXT_PUBLIC_API_URL=http://localhost:4000

# Optional
NEXT_PUBLIC_APP_ENV=development
NEXT_PUBLIC_ENABLE_ANALYTICS=false

# Optional. Comma-separated STUN URLs.
NEXT_PUBLIC_STUN_URLS=stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478

# Optional self-hosted coturn. Keep these values in .env.local, not in git.
# Include TCP/TLS on port 443 for restrictive networks such as college Wi-Fi.
NEXT_PUBLIC_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:443?transport=tcp
NEXT_PUBLIC_TURN_USERNAME=globalsend
NEXT_PUBLIC_TURN_CREDENTIAL=replace-me

# Optional tuning.
NEXT_PUBLIC_ICE_TRANSPORT_POLICY=all
NEXT_PUBLIC_TRANSFER_SHARDS=3
```

For a real deployment, point `NEXT_PUBLIC_API_URL` at your hosted backend (the frontend rewrites `http`→`ws` for the socket). Deploy the frontend anywhere that runs Next.js and the backend on any Bun‑friendly host (Fly, Railway, Render, a VPS…).

> ⚠️ **Note:** STUN cannot bypass a firewall that blocks peer traffic. For college or corporate Wi-Fi, use a coturn server with `turns:` on TCP 443, a valid TLS certificate, and a configured relay port range. Direct connections remain preferred when `NEXT_PUBLIC_ICE_TRANSPORT_POLICY=all`; TURN is used when needed. `NEXT_PUBLIC_TRANSFER_SHARDS` controls parallel PeerConnections and defaults to 3.

---

## 🔐 Security & privacy

- **Files never touch the server.** The backend only relays signaling metadata — there is no upload endpoint.
- **Transport encryption** is provided by WebRTC's mandatory DTLS/SRTP. An optional app‑layer passphrase E2E encryption is planned.
- **Anonymous & ephemeral** — identities are random per session and expire on disconnect. No accounts, no persistent user data.
- **Validated inputs** — all signaling messages are Zod‑validated server‑side.

GlobalSend is under active development and has not undergone a formal security audit. Review the code before using it for sensitive data.

---

## 🤝 Contributing

Contributions are welcome! Whether it's the frontend, the signaling backend, docs, or the roadmap items above — open an issue to discuss, or send a PR. The [`PROJECT_PLAN.md`](PROJECT_PLAN.md) is the best place to understand intended architecture and priorities.

---

## 🙏 Credits

- **[LocalSend](https://localsend.org/)** — a superb open‑source local file‑sharing project whose implementation was a valuable reference for parts of GlobalSend's WebRTC transfer flow. Go star it.
- **[Magic Wormhole](https://github.com/magic-wormhole/magic-wormhole)** — inspiration for friction‑free, code‑based pairing.
- Built with WebRTC, Hono, Next.js, and Bun.

---

## 📄 License

Released under the **GNU Affero General Public License v3.0**. See [LICENSE](LICENSE) for the full terms.

<div align="center">
<br />

**Made with 🌀 for sending files the way it should be — direct, private, and everywhere.**

</div>
