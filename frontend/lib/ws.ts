import { PeerConnectionManager } from "@/webrtc/PeerConnectionManager";
import { wsUrl } from "@/src/config";

type Peer = { id: string; alias: string };

type TransferFile = {
  name: string;
  size: number;
  mimeType: string;
};

type FileTransferRecord = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  objectUrl: string;
  from: string;
};

type Handlers = {
  onPeerList: (peers: Peer[]) => void;
  onPeerJoined: (peer: Peer) => void;
  onPeerLeft: (peerId: string) => void;
  onTransferInvite: (from: string, file: TransferFile) => void;
  onTransferAccepted: (from: string) => void;
  onTransferDeclined: (from: string) => void;
  onDataChannelOpen: (peerId: string) => void;
  onDataChannelMessage: (peerId: string, data: string | ArrayBuffer) => void;
  onFileStart: (
    peerId: string,
    file: {
      id: string;
      name: string;
      mimeType: string;
      size: number;
      chunkCount: number;
    },
  ) => void;
  onFileProgress: (
    peerId: string,
    progress: {
      id: string;
      transferredBytes: number;
      totalBytes: number;
      direction: "send" | "receive";
    },
  ) => void;
  onFileComplete: (peerId: string, file: FileTransferRecord) => void;
  onLog: (msg: string) => void;
  // New: called when WS drops and we're attempting to reconnect
  onReconnecting?: (attempt: number) => void;
  // New: called when WS successfully reconnects
  onReconnected?: () => void;
};

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export class WSClient {
  private ws!: WebSocket;
  private sessionId: string;
  private alias: string;
  private peers = new Map<string, PeerConnectionManager>();
  private handlers: Handlers;
  private heartbeatTimer: number | null = null;

  // Reconnect state
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private isDisposed = false;
  private isFirstConnect = true;

  constructor(sessionId: string, alias: string, handlers: Handlers) {
    this.sessionId = sessionId;
    this.alias = alias;
    this.handlers = handlers;
    this.connect();
  }

  // ─── WebSocket lifecycle ───────────────────────────────────────────────────

  private connect() {
    // Use an env var for the WS URL so it works on both local and deployed
    const ws = new WebSocket(`${wsUrl}/ws?id=${this.sessionId}`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.isDisposed || ws !== this.ws) {
        ws.close();
        return;
      }

      this.log(this.isFirstConnect ? "WS connected" : "WS reconnected");
      this.reconnectAttempt = 0;

      // Re-join with the same alias every time — backend upserts presence
      ws.send(JSON.stringify({ type: "join", alias: this.alias }));
      this.startHeartbeat();

      if (!this.isFirstConnect) {
        this.handlers.onReconnected?.();
      }
      this.isFirstConnect = false;
    };

    ws.onmessage = (event) => {
      if (this.isDisposed || ws !== this.ws) return;
      this.handleMessage(event);
    };

    ws.onclose = () => {
      if (this.isDisposed || ws !== this.ws) return;

      this.log("WS disconnected");
      this.stopHeartbeat();
      this.scheduleReconnect();
    };

    ws.onerror = (event) => {
      if (this.isDisposed || ws !== this.ws) return;

      // onerror always fires before onclose, so we just log here —
      // the reconnect logic lives in onclose to avoid double-scheduling
      this.log(`WS error: ${String(event)}`);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return; // already scheduled

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)
    const delay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempt),
      BACKOFF_MAX_MS,
    );
    this.reconnectAttempt += 1;

    this.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`,
    );
    this.handlers.onReconnecting?.(this.reconnectAttempt);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isDisposed) {
        this.connect();
      }
    }, delay);
  }

  // ─── Message handling ──────────────────────────────────────────────────────

  private handleMessage(event: MessageEvent) {
    const msg = JSON.parse(event.data);
    this.log(`← ${msg.type}${msg.from ? ` from ${msg.from}` : ""}`);

    switch (msg.type) {
      case "peer_list":
        this.handlers.onPeerList(msg.peers);
        break;
      case "peer_joined":
        this.handlers.onPeerJoined(msg.peer);
        break;
      case "peer_left":
        this.handlers.onPeerLeft(msg.id);
        this.peers.get(msg.id)?.close();
        this.peers.delete(msg.id);
        break;
      case "transfer-invite":
        this.handlers.onTransferInvite(msg.from, msg.file);
        break;
      case "transfer-accept":
        this.log(
          `Transfer accepted by ${msg.from} - starting WebRTC as sender`,
        );
        this.handlers.onTransferAccepted(msg.from);
        this.initAsSender(msg.from);
        break;
      case "transfer-decline":
        this.handlers.onTransferDeclined(msg.from);
        break;
      case "offer":
        this.log(`Offer received from ${msg.from} - initialising as receiver`);
        void this.getOrCreatePeer(msg.from).then((pc) =>
          pc.handleOffer(msg.data),
        );
        break;
      case "answer":
        void this.peers.get(msg.from)?.handleAnswer(msg.data);
        break;
      case "candidate":
        void this.peers.get(msg.from)?.handleCandidate(msg.data);
        break;
    }
  }

  // ─── Peer connection management ────────────────────────────────────────────

  private initAsSender(remotePeerId: string) {
    const pc = this.createPeerConnection(remotePeerId);
    pc.initAsSender();
  }

  private async getOrCreatePeer(
    remotePeerId: string,
  ): Promise<PeerConnectionManager> {
    const existing = this.peers.get(remotePeerId);
    if (existing) return existing;
    const pc = this.createPeerConnection(remotePeerId);
    pc.initAsReceiver();
    return pc;
  }

  private createPeerConnection(remotePeerId: string): PeerConnectionManager {
    const existing = this.peers.get(remotePeerId);
    if (existing) return existing;

    // Pass a getter for this.ws rather than the ws instance directly.
    // This means PeerConnectionManager always uses the *current* socket,
    // even after a reconnect replaces this.ws with a new WebSocket object.
    const pc = new PeerConnectionManager(() => this.ws, remotePeerId);

    pc.onOpen = () => {
      this.log(`DataChannel OPEN with ${remotePeerId}`);
      this.handlers.onDataChannelOpen(remotePeerId);
    };

    pc.onMessage = (data) => {
      this.log(
        `DataChannel message from ${remotePeerId}: ${typeof data === "string" ? data : "[binary]"}`,
      );
      this.handlers.onDataChannelMessage(remotePeerId, data);
    };

    pc.onFileStart = (file) => {
      this.log(`Receiving ${file.name} from ${remotePeerId}`);
      this.handlers.onFileStart(remotePeerId, file);
    };

    pc.onFileProgress = (progress) => {
      this.handlers.onFileProgress(remotePeerId, {
        id: progress.id,
        transferredBytes: progress.receivedBytes,
        totalBytes: progress.totalBytes,
        direction: "receive",
      });
    };

    pc.onFileComplete = (file) => {
      const objectUrl = URL.createObjectURL(file.blob);
      this.log(`File received from ${remotePeerId}: ${file.name}`);
      this.handlers.onFileComplete(remotePeerId, {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        objectUrl,
        from: remotePeerId,
      });
    };

    pc.onClose = () => {
      this.log(`DataChannel closed with ${remotePeerId}`);
      this.peers.delete(remotePeerId);
    };

    pc.onLog = (message) => this.log(`${remotePeerId}: ${message}`);

    this.peers.set(remotePeerId, pc);
    return pc;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  public sendTransferInvite(to: string, file: TransferFile) {
    this.log(`→ transfer-invite to ${to}`);
    this.safeSend({ type: "transfer-invite", to, file });
  }

  public sendTransferAccept(to: string) {
    this.log(`→ transfer-accept to ${to}`);
    this.safeSend({ type: "transfer-accept", to });
    void this.getOrCreatePeer(to);
  }

  public sendTransferDecline(to: string) {
    this.log(`→ transfer-decline to ${to}`);
    this.safeSend({ type: "transfer-decline", to });
  }

  public sendDataChannelMessage(to: string, message: string) {
    this.peers.get(to)?.sendMessage(message);
  }

  public async sendFile(to: string, file: File) {
    const peer = this.peers.get(to);
    if (!peer) throw new Error(`Peer ${to} is not connected`);

    await peer.sendFile(file, {
      onProgress: (sentBytes, totalBytes) => {
        this.handlers.onFileProgress(to, {
          id: `${to}:${file.name}`,
          transferredBytes: sentBytes,
          totalBytes,
          direction: "send",
        });
      },
    });
  }

  public dispose() {
    this.isDisposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, peer] of this.peers) {
      peer.close();
    }
    this.peers.clear();
    this.ws.close();
  }

  public getSessionId() {
    return this.sessionId;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  // Safely send on the WS — silently drops if not yet connected (mid-reconnect).
  // For signaling messages this is fine: if WS is down, the remote peer is also
  // likely disconnected and will re-invite when both sides are back.
  private safeSend(payload: object) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      this.log(`safeSend dropped (WS not open): ${JSON.stringify(payload)}`);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private log(msg: string) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    console.log(line);
    this.handlers.onLog(line);
  }
}
