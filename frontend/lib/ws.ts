import {
  FileManifest,
  PeerConnectionManager,
} from "@/webrtc/PeerConnectionManager";
import { transferShardCount, wsUrl } from "@/src/config";

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

type IncomingTransfer = {
  meta: FileManifest;
  buffers: ArrayBuffer[];
  pendingChunks: Map<number, ArrayBuffer>;
  nextChunkIndex: number;
  receivedChunks: number;
  receivedBytes: number;
  completedShards: Set<number>;
  sink: FileSystemWritableFileStream | null;
  sinkReady: Promise<FileSystemWritableFileStream | null>;
  writeChain: Promise<void>;
};

type Handlers = {
  onPeerList: (peers: Peer[]) => void;
  onPeerJoined: (peer: Peer) => void;
  onPeerLeft: (peerId: string) => void;
  onTransferInvite: (from: string, file?: TransferFile) => void;
  onTransferAccepted: (from: string) => void;
  onTransferDeclined: (from: string) => void;
  onDataChannelOpen: (peerId: string) => void;
  onDataChannelClose: (peerId: string) => void;
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
  onReconnecting?: (attempt: number) => void;
  onReconnected?: () => void;
};

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const MAX_READ_AHEAD = 8;

class PeerConnectionGroup {
  private shards = new Map<number, PeerConnectionManager>();
  private incomingTransfer: IncomingTransfer | null = null;
  private openWasReported = false;
  private closed = false;

  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (data: string | ArrayBuffer) => void;
  onFileStart?: (meta: FileManifest) => void;
  onFileProgress?: (progress: {
    id: string;
    transferredBytes: number;
    totalBytes: number;
  }) => void;
  onFileComplete?: (file: {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    blob?: Blob;
    savedToDisk: boolean;
  }) => void;
  onLog?: (message: string) => void;

  constructor(
    private getWs: () => WebSocket,
    private remotePeerId: string,
    private shardCount: number,
  ) {}

  public initAsSender() {
    for (let shardId = 0; shardId < this.shardCount; shardId += 1) {
      this.getOrCreateShard(shardId).initAsSender();
    }
  }

  public initAsReceiver() {
    for (let shardId = 0; shardId < this.shardCount; shardId += 1) {
      this.getOrCreateShard(shardId).initAsReceiver();
    }
  }

  public async handleOffer(shardId: number, sdp: RTCSessionDescriptionInit) {
    const shard = this.getOrCreateShard(shardId);
    shard.initAsReceiver();
    await shard.handleOffer(sdp);
  }

  public async handleAnswer(shardId: number, sdp: RTCSessionDescriptionInit) {
    await this.shards.get(shardId)?.handleAnswer(sdp);
  }

  public async handleCandidate(shardId: number, candidate: RTCIceCandidateInit) {
    await this.shards.get(shardId)?.handleCandidate(candidate);
  }

  public isOpen() {
    return this.getOpenShards().length > 0;
  }

  public sendMessage(data: string | ArrayBuffer) {
    this.getOpenShards()[0]?.[1].sendMessage(data);
  }

  public async sendFile(
    file: File,
    handlers?: {
      onProgress?: (sentBytes: number, totalBytes: number) => void;
    },
  ) {
    const openShards = this.getOpenShards();
    if (openShards.length === 0) {
      throw new Error("No WebRTC data-channel shard is open");
    }

    const chunkSize = Math.min(
      ...openShards.map(([, shard]) => shard.getChunkSize()),
    );
    const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
    const transferId = crypto.randomUUID();
    const manifest: FileManifest = {
      kind: "file-meta",
      id: transferId,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      chunkSize,
      chunkCount,
      shardCount: openShards.length,
    };

    for (const [, shard] of openShards) shard.sendFileMeta(manifest);

    let sentBytes = 0;
    await Promise.all(
      openShards.map(async ([, shard], workerIndex) => {
        const pending: Array<{
          index: number;
          buffer: Promise<ArrayBuffer>;
        }> = [];
        let nextIndex = workerIndex;

        const queueChunk = () => {
          if (nextIndex >= chunkCount) return;
          const index = nextIndex;
          nextIndex += openShards.length;
          const offset = index * chunkSize;
          pending.push({
            index,
            buffer: file
              .slice(offset, Math.min(file.size, offset + chunkSize))
              .arrayBuffer(),
          });
        };

        while (
          pending.length < MAX_READ_AHEAD &&
          nextIndex < chunkCount
        ) {
          queueChunk();
        }

        while (pending.length > 0) {
          const chunk = pending.shift()!;
          queueChunk();
          const buffer = await chunk.buffer;
          await shard.sendChunk(chunk.index, buffer);
          sentBytes += buffer.byteLength;
          handlers?.onProgress?.(sentBytes, file.size);
        }

        shard.sendFileComplete(transferId);
      }),
    );
  }

  public close() {
    this.closed = true;
    for (const shard of this.shards.values()) shard.close();
    this.shards.clear();
    this.incomingTransfer = null;
  }

  private getOrCreateShard(shardId: number) {
    const existing = this.shards.get(shardId);
    if (existing) return existing;

    const shard = new PeerConnectionManager(
      this.getWs,
      this.remotePeerId,
      shardId,
    );
    shard.onOpen = () => {
      if (!this.openWasReported) {
        this.openWasReported = true;
        this.onOpen?.();
      }
      this.onLog?.(
        `DataChannel shard ${shardId} open (${this.getOpenShards().length}/${this.shardCount})`,
      );
    };
    shard.onClose = () => {
      if (!this.closed && this.getOpenShards().length === 0) {
        this.onClose?.();
      }
    };
    shard.onMessage = (data) => this.onMessage?.(data);
    shard.onFileMeta = (meta) => this.handleFileMeta(meta);
    shard.onFileChunk = (chunk) => this.handleFileChunk(chunk);
    shard.onFileComplete = (transferId) =>
      this.handleFileComplete(shardId, transferId);
    shard.onLog = (message) => this.onLog?.(`${this.remotePeerId}: ${message}`);
    this.shards.set(shardId, shard);
    return shard;
  }

  private getOpenShards() {
    return [...this.shards.entries()].filter(([, shard]) => shard.isOpen());
  }

  private handleFileMeta(meta: FileManifest) {
    if (this.incomingTransfer?.meta.id === meta.id) return;
    if (this.incomingTransfer) {
      this.onLog?.("Ignoring a new file while another file is still arriving");
      return;
    }

    this.incomingTransfer = {
      meta,
      buffers: [],
      pendingChunks: new Map(),
      nextChunkIndex: 0,
      receivedChunks: 0,
      receivedBytes: 0,
      completedShards: new Set(),
      sink: null,
      sinkReady: this.openFileSink(meta),
      writeChain: Promise.resolve(),
    };
    this.onFileStart?.(meta);
  }

  private handleFileChunk(chunk: { index: number; data: ArrayBuffer }) {
    const transfer = this.incomingTransfer;
    if (!transfer || transfer.pendingChunks.has(chunk.index)) return;

    transfer.pendingChunks.set(chunk.index, chunk.data);
    transfer.receivedChunks += 1;
    transfer.receivedBytes += chunk.data.byteLength;
    this.flushIncomingChunks(transfer);
    this.onFileProgress?.({
      id: transfer.meta.id,
      transferredBytes: transfer.receivedBytes,
      totalBytes: transfer.meta.size,
    });
    this.tryCompleteIncoming(transfer);
  }

  private flushIncomingChunks(transfer: IncomingTransfer) {
    while (transfer.pendingChunks.has(transfer.nextChunkIndex)) {
      const data = transfer.pendingChunks.get(transfer.nextChunkIndex)!;
      transfer.pendingChunks.delete(transfer.nextChunkIndex);
      transfer.nextChunkIndex += 1;
      transfer.writeChain = transfer.writeChain.then(async () => {
        const sink = await transfer.sinkReady;
        if (sink) {
          await sink.write(new Uint8Array(data));
          transfer.sink = sink;
        } else {
          transfer.buffers.push(data);
        }
      });
    }
  }

  private handleFileComplete(shardId: number, transferId: string) {
    const transfer = this.incomingTransfer;
    if (!transfer || transfer.meta.id !== transferId) return;
    transfer.completedShards.add(shardId);
    this.tryCompleteIncoming(transfer);
  }

  private tryCompleteIncoming(transfer: IncomingTransfer) {
    if (
      transfer.completedShards.size < transfer.meta.shardCount ||
      transfer.receivedChunks < transfer.meta.chunkCount ||
      transfer.nextChunkIndex < transfer.meta.chunkCount
    ) {
      return;
    }

    this.incomingTransfer = null;
    void (async () => {
      await transfer.writeChain;
      const sink = await transfer.sinkReady;
      if (sink) await sink.close();
      const blob = sink
        ? undefined
        : new Blob(transfer.buffers, {
            type: transfer.meta.mimeType || "application/octet-stream",
          });
      if (transfer.receivedBytes !== transfer.meta.size) {
        this.onLog?.(
          `Transfer ${transfer.meta.name} ended with ${transfer.receivedBytes}/${transfer.meta.size} bytes`,
        );
      }
      this.onFileComplete?.({
        id: transfer.meta.id,
        name: transfer.meta.name,
        mimeType: transfer.meta.mimeType,
        size: transfer.receivedBytes,
        blob,
        savedToDisk: Boolean(sink),
      });
    })();
  }

  private async openFileSink(meta: FileManifest) {
    if (!("showSaveFilePicker" in window)) return null;

    try {
      const picker = (window as Window & {
        showSaveFilePicker?: (options?: object) => Promise<{
          createWritable: () => Promise<FileSystemWritableFileStream>;
        }>;
      }).showSaveFilePicker;
      if (!picker) return null;
      const handle = await picker({
        suggestedName: meta.name,
        types: [{
          description: meta.mimeType || "File",
          accept: { [meta.mimeType || "application/octet-stream"]: [".bin"] },
        }],
      });
      return await handle.createWritable();
    } catch {
      return null;
    }
  }
}

export class WSClient {
  private ws!: WebSocket;
  private sessionId: string;
  private alias: string;
  private peers = new Map<string, PeerConnectionGroup>();
  private handlers: Handlers;
  private heartbeatTimer: number | null = null;
  private autoReconnectPeerIds = new Set<string>();
  private previouslyConnectedPeerIds = new Set<string>();
  private reconnectFallbackTimers = new Map<string, number>();
  private shouldRestorePeers = false;
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

  private connect() {
    const ws = new WebSocket(`${wsUrl}/ws?id=${this.sessionId}`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.isDisposed || ws !== this.ws) {
        ws.close();
        return;
      }
      this.log(this.isFirstConnect ? "WS connected" : "WS reconnected");
      this.reconnectAttempt = 0;
      ws.send(JSON.stringify({ type: "join", alias: this.alias }));
      this.startHeartbeat();
      if (!this.isFirstConnect) {
        this.handlers.onReconnected?.();
        this.shouldRestorePeers = this.autoReconnectPeerIds.size > 0;
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
      this.rememberOpenPeersForReconnect();
      this.closePeerConnections();
      this.stopHeartbeat();
      this.scheduleReconnect();
    };

    ws.onerror = (event) => {
      if (this.isDisposed || ws !== this.ws) return;
      this.log(`WS error: ${String(event)}`);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempt),
      BACKOFF_MAX_MS,
    );
    this.reconnectAttempt += 1;
    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);
    this.handlers.onReconnecting?.(this.reconnectAttempt);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isDisposed) this.connect();
    }, delay);
  }

  private handleMessage(event: MessageEvent) {
    const msg = JSON.parse(event.data);
    const shardId = Number.isInteger(msg.shardId) ? msg.shardId : 0;
    this.log(`<- ${msg.type}${msg.from ? ` from ${msg.from}` : ""}${msg.shardId !== undefined ? ` shard ${shardId}` : ""}`);

    switch (msg.type) {
      case "peer_list":
        this.handlers.onPeerList(msg.peers);
        this.restorePeerConnections(msg.peers);
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
        if (!msg.file && this.previouslyConnectedPeerIds.has(msg.from)) {
          this.clearReconnectFallback(msg.from);
          this.log(`Auto-accepting reconnect invite from ${msg.from}`);
          this.sendTransferAccept(msg.from);
          break;
        }
        this.handlers.onTransferInvite(msg.from, msg.file);
        break;
      case "transfer-accept":
        this.log(`Transfer accepted by ${msg.from} - starting WebRTC shards`);
        this.handlers.onTransferAccepted(msg.from);
        this.getOrCreatePeer(msg.from).initAsSender();
        break;
      case "transfer-decline":
        this.handlers.onTransferDeclined(msg.from);
        break;
      case "offer":
        void this.getOrCreatePeer(msg.from).handleOffer(shardId, msg.data);
        break;
      case "answer":
        void this.peers.get(msg.from)?.handleAnswer(shardId, msg.data);
        break;
      case "candidate":
        void this.peers.get(msg.from)?.handleCandidate(shardId, msg.data);
        break;
    }
  }

  public sendTransferInvite(to: string, file?: TransferFile) {
    this.log(`-> transfer-invite to ${to}`);
    this.safeSend({ type: "transfer-invite", to, file });
  }

  public sendTransferAccept(to: string) {
    this.log(`-> transfer-accept to ${to}`);
    this.safeSend({ type: "transfer-accept", to });
    this.getOrCreatePeer(to).initAsReceiver();
  }

  public sendTransferDecline(to: string) {
    this.log(`-> transfer-decline to ${to}`);
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
    this.clearReconnectFallbacks();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.ws.close();
  }

  public getSessionId() {
    return this.sessionId;
  }

  private getOrCreatePeer(remotePeerId: string) {
    const existing = this.peers.get(remotePeerId);
    if (existing) return existing;

    const group = new PeerConnectionGroup(
      () => this.ws,
      remotePeerId,
      transferShardCount,
    );
    group.onOpen = () => {
      this.log(`DataChannel ready with ${remotePeerId}`);
      this.previouslyConnectedPeerIds.add(remotePeerId);
      this.autoReconnectPeerIds.delete(remotePeerId);
      this.clearReconnectFallback(remotePeerId);
      this.handlers.onDataChannelOpen(remotePeerId);
    };
    group.onClose = () => {
      this.log(`All DataChannel shards closed with ${remotePeerId}`);
      if (this.peers.get(remotePeerId) === group) this.peers.delete(remotePeerId);
      this.handlers.onDataChannelClose(remotePeerId);
    };
    group.onMessage = (data) => {
      this.log(`DataChannel message from ${remotePeerId}`);
      this.handlers.onDataChannelMessage(remotePeerId, data);
    };
    group.onFileStart = (file) => {
      this.log(`Receiving ${file.name} from ${remotePeerId}`);
      this.handlers.onFileStart(remotePeerId, file);
    };
    group.onFileProgress = (progress) => {
      this.handlers.onFileProgress(remotePeerId, {
        id: progress.id,
        transferredBytes: progress.transferredBytes,
        totalBytes: progress.totalBytes,
        direction: "receive",
      });
    };
    group.onFileComplete = (file) => {
      const objectUrl = file.blob ? URL.createObjectURL(file.blob) : "";
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
    group.onLog = (message) => this.log(message);
    this.peers.set(remotePeerId, group);
    return group;
  }

  private safeSend(payload: object) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      this.log(`safeSend dropped (WS not open): ${JSON.stringify(payload)}`);
    }
  }

  private rememberOpenPeersForReconnect() {
    this.autoReconnectPeerIds.clear();
    for (const [peerId, peer] of this.peers) {
      if (peer.isOpen()) this.autoReconnectPeerIds.add(peerId);
    }
    if (this.autoReconnectPeerIds.size > 0) {
      this.log(`Will restore peer connection(s): ${[...this.autoReconnectPeerIds].join(", ")}`);
    }
  }

  private closePeerConnections() {
    this.clearReconnectFallbacks();
    for (const [peerId, peer] of this.peers) {
      peer.close();
      this.handlers.onDataChannelClose(peerId);
    }
    this.peers.clear();
  }

  private restorePeerConnections(peers: Peer[]) {
    if (!this.shouldRestorePeers) return;
    this.shouldRestorePeers = false;
    for (const peerId of this.autoReconnectPeerIds) {
      if (!peers.some((peer) => peer.id === peerId)) {
        this.log(`Peer reconnect skipped: ${peerId} is not visible`);
        this.autoReconnectPeerIds.delete(peerId);
        this.handlers.onDataChannelClose(peerId);
        continue;
      }

      if (this.sessionId < peerId) {
        this.log(`Trying to restore WebRTC connection with ${peerId}`);
        this.sendTransferInvite(peerId);
      } else {
        this.log(`Waiting for ${peerId} to restore WebRTC connection`);
        const timer = window.setTimeout(() => {
          this.reconnectFallbackTimers.delete(peerId);
          if (!this.autoReconnectPeerIds.has(peerId) || this.peers.has(peerId)) return;
          this.log(`Fallback restore attempt with ${peerId}`);
          this.sendTransferInvite(peerId);
        }, 2000);
        this.reconnectFallbackTimers.set(peerId, timer);
      }
    }
  }

  private clearReconnectFallback(peerId: string) {
    const timer = this.reconnectFallbackTimers.get(peerId);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.reconnectFallbackTimers.delete(peerId);
  }

  private clearReconnectFallbacks() {
    for (const timer of this.reconnectFallbackTimers.values()) {
      window.clearTimeout(timer);
    }
    this.reconnectFallbackTimers.clear();
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
