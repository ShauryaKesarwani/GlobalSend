<div align="center">

# 🌀 Rift

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

## ✨ What is Rift?

**Rift** is an open‑source, browser‑to‑browser file transfer tool. Two people open the app, see each other in a live presence list, and send files **directly** to one another over an encrypted [WebRTC](https://webrtc.org/) DataChannel.

The key idea: **your file bytes never travel through our servers.** The backend only helps two browsers find each other and shake hands (signaling + presence). Once the connection is established, the server steps out of the way and bytes flow peer‑to‑peer.

> Think **AirDrop for the whole internet**, running entirely in a browser tab — no app to install, works beyond your local network.

### Why it's nice

- 🌍 **Works across the internet**, not just your LAN — unlike most local‑network tools.
- 🖥️ **Zero install** — it's a web app. Open it on a phone, a work laptop, a locked‑down machine.
- 🔒 **Bytes stay private** — files go browser‑to‑browser over WebRTC's built‑in DTLS encryption. The server literally never sees them.
- 📷 **QR + deep‑link pairing** — scan a code from another device to auto‑connect.
- ⚡ **Fast** — 256 KB chunks with backpressure control keep transfers smooth without blowing up memory.

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
                     WebRTC DataChannel (encrypted)
                        file bytes, direct P2P
```

The transfer lifecycle, one line per step:

1. **A** clicks *Send* → app sends a `transfer-invite` over the WebSocket.
2. **B** sees a popup, clicks *Accept* → app sends `transfer-accept`.
3. **A** creates an `RTCDataChannel`, builds an SDP **offer**, relays it via the server.
4. **B** answers; both sides exchange **ICE candidates** through the server.
5. The browser picks the best network path → the **DataChannel opens**.
6. **A** streams a file manifest, then chunks. **B** reassembles and gets a download. **The server is now out of the loop.**

---

## 🎯 Current features

| | Feature | Notes |
|---|---|---|
| ✅ | **Internet‑wide P2P transfer** | WebRTC DataChannel with Google STUN for NAT traversal |
| ✅ | **Live presence list** | See who's online in real time via WebSocket heartbeats |
| ✅ | **Invite / accept handshake** | Consent‑based — nothing sends until the receiver accepts |
| ✅ | **Multiple‑file transfers** | Queue and send several files in one session |
| ✅ | **QR code + deep‑link pairing** | Scan from a second device to auto‑connect to a peer |
| ✅ | **Chunked streaming with backpressure** | 256 KB chunks, `bufferedAmount` high/low watermarks |
| ✅ | **Live progress** | Per‑file transferred / total bytes, both send and receive |
| ✅ | **Reconnection resilience** | WebSocket auto‑reconnects with exponential backoff and restores in‑flight peer connections |
| ✅ | **Ephemeral anonymous identity** | Random session ID + alias generated per tab — no sign‑up, nothing stored |
| ✅ | **Schema‑validated signaling** | Every WebSocket message is Zod‑validated on the backend |

---

## 🆚 How Rift compares

|  | **🌀 Rift** | **[LocalSend](https://localsend.org/)** | **[Magic Wormhole](https://github.com/magic-wormhole/magic-wormhole)** |
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

- **LocalSend** is fantastic for the same Wi‑Fi network and gives you polished native apps — but it can't reach a friend across the country. Rift's whole point is working *beyond* the LAN.
- **Magic Wormhole** is a brilliant, battle‑tested CLI with strong end‑to‑end crypto, but it's terminal‑bound and routes data through a transit relay when a direct connection fails. Rift aims for a direct browser‑to‑browser path and a zero‑friction, no‑install UX.
- **Rift** trades native‑app depth for reach and convenience: nothing to install, works over the internet, and runs anywhere a modern browser does.

> 💡 Rift's WebRTC handshake and chunking approach draw inspiration from **LocalSend's** open implementation — huge thanks to that project (see [Credits](#-credits)).

---

## 🗺️ Roadmap

Planned and in‑progress work:

- 🔐 **Optional passphrase‑based app‑layer E2E encryption** on top of the DataChannel
- ♻️ **Resumable transfers** with chunk‑range reconciliation after a drop
- 📁 **Folder transfers** and richer multi‑file queueing
- 🔀 **TURN relay fallback** for the strictest NATs and firewalls (config path already stubbed)
- 💾 **Streaming to disk** via the File System Access API (today large files buffer in memory)
- 🧾 **Integrity verification** — end‑to‑end checksum before the save prompt
- 🛡️ **Abuse controls** — invite rate limiting and payload size caps
- 🚪 **Rooms / contacts** and optional transfer history

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the full design document.

---

## 🏗️ Architecture

Rift is split into three planes:

- **Control plane** — presence + signaling, over WebSocket (`backend`)
- **Data plane** — the actual file bytes, strictly browser‑to‑browser over WebRTC (`frontend`)
- **Persistence plane** — metadata only; **never** file blobs *(planned: Neon Postgres)*

```
rift/
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

**Connectivity** — Google STUN (`stun.l.google.com:19302`), TURN‑ready abstraction for later

---

## 🚀 Getting started (self‑hosting)

Rift is meant to be self‑hosted — run your own signaling backend and frontend. You'll need [**Bun**](https://bun.sh/) installed.

### 1. Clone

```sh
git clone https://github.com/ShauryaKesarwani/GlobalSend.git rift
cd rift
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
```

For a real deployment, point `NEXT_PUBLIC_API_URL` at your hosted backend (the frontend rewrites `http`→`ws` for the socket). Deploy the frontend anywhere that runs Next.js and the backend on any Bun‑friendly host (Fly, Railway, Render, a VPS…).

> ⚠️ **Note:** With STUN‑only connectivity, some strict/symmetric NATs and firewalls will fail to establish a direct connection. A TURN relay fallback is on the [roadmap](#-roadmap); until then, plug your own TURN server into the ICE config for maximum reach.

---

## 🔐 Security & privacy

- **Files never touch the server.** The backend only relays signaling metadata — there is no upload endpoint.
- **Transport encryption** is provided by WebRTC's mandatory DTLS/SRTP. An optional app‑layer passphrase E2E encryption is planned.
- **Anonymous & ephemeral** — identities are random per session and expire on disconnect. No accounts, no persistent user data.
- **Validated inputs** — all signaling messages are Zod‑validated server‑side.

Rift is under active development and has not undergone a formal security audit. Review the code before using it for sensitive data.

---

## 🤝 Contributing

Contributions are welcome! Whether it's the frontend, the signaling backend, docs, or the roadmap items above — open an issue to discuss, or send a PR. The [`PROJECT_PLAN.md`](PROJECT_PLAN.md) is the best place to understand intended architecture and priorities.

---

## 🙏 Credits

- **[LocalSend](https://localsend.org/)** — a superb open‑source local file‑sharing project whose implementation was a valuable reference for parts of Rift's WebRTC transfer flow. Go star it.
- **[Magic Wormhole](https://github.com/magic-wormhole/magic-wormhole)** — inspiration for friction‑free, code‑based pairing.
- Built with WebRTC, Hono, Next.js, and Bun.

---

## 📄 License

Released under the **MIT License** — free to use, modify, and self‑host. *(Add a `LICENSE` file to the repo to make this official.)*

<div align="center">
<br />

**Made with 🌀 for sending files the way it should be — direct, private, and everywhere.**

</div>
