import { iceServers, iceTransportPolicy } from "@/src/config";

const CONTROL_PREFIX = "__rift_ctrl__";
const CHUNK_SIZE = 64 * 1024;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_MAGIC = 0x52494654;
const HIGH_WATER_MARK = 2 * 1024 * 1024;
const LOW_WATER_MARK = 1 * 1024 * 1024;

export type FileManifest = {
  kind: "file-meta";
  id: string;
  name: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  shardCount: number;
};

type FileComplete = {
  kind: "file-complete";
  id: string;
};

type ControlMessage = FileManifest | FileComplete;

export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private initialized = false;

  onMessage?: (data: string | ArrayBuffer) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onFileMeta?: (meta: FileManifest) => void;
  onFileChunk?: (chunk: { index: number; data: ArrayBuffer }) => void;
  onFileComplete?: (transferId: string) => void;
  onLog?: (message: string) => void;

  constructor(
    private getWs: () => WebSocket,
    private remotePeerId: string,
    private shardId: number,
  ) {}

  public initAsSender() {
    if (this.initialized) return;
    this.initialized = true;
    this.createPeerConnection();
    this.dc = this.pc!.createDataChannel("file-transfer", { ordered: true });
    this.setupDataChannelListeners();
    void this.createAndSendOffer();
  }

  public initAsReceiver() {
    if (this.initialized) return;
    this.initialized = true;
    this.createPeerConnection();
    this.pc!.ondatachannel = (event) => {
      this.dc = event.channel;
      this.setupDataChannelListeners();
    };
  }

  public async handleOffer(sdp: RTCSessionDescriptionInit) {
    await this.pc!.setRemoteDescription(sdp);
    this.remoteDescriptionSet = true;
    await this.flushCandidates();
    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    this.sendSignal({ type: "answer", data: answer });
  }

  public async handleAnswer(sdp: RTCSessionDescriptionInit) {
    await this.pc!.setRemoteDescription(sdp);
    this.remoteDescriptionSet = true;
    await this.flushCandidates();
  }

  public async handleCandidate(candidate: RTCIceCandidateInit) {
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc!.addIceCandidate(candidate);
  }

  public sendMessage(data: string | ArrayBuffer) {
    if (this.dc?.readyState !== "open") return;
    if (typeof data === "string") {
      this.dc.send(data);
    } else {
      this.dc.send(data);
    }
  }

  public sendFileMeta(meta: FileManifest) {
    this.sendControlMessage(meta);
  }

  public sendFileComplete(transferId: string) {
    this.sendControlMessage({ kind: "file-complete", id: transferId });
  }

  public async sendChunk(index: number, data: ArrayBuffer) {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error(`Data channel shard ${this.shardId} is not open`);
    }

    await this.waitForBufferedAmountLow();
    const packet = new Uint8Array(CHUNK_HEADER_BYTES + data.byteLength);
    const header = new DataView(packet.buffer);
    header.setUint32(0, CHUNK_MAGIC);
    header.setUint32(4, index);
    packet.set(new Uint8Array(data), CHUNK_HEADER_BYTES);
    this.dc.send(packet.buffer);
  }

  public getChunkSize() {
    const maxMessageSize = this.pc?.sctp?.maxMessageSize;
    if (!maxMessageSize || !Number.isFinite(maxMessageSize)) return CHUNK_SIZE;
    return Math.max(
      16 * 1024,
      Math.min(CHUNK_SIZE, maxMessageSize - CHUNK_HEADER_BYTES),
    );
  }

  public isOpen() {
    return this.dc?.readyState === "open";
  }

  public close() {
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    this.initialized = false;
  }

  private createPeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (!state) return;
      this.onLog?.(`Shard ${this.shardId} connection state: ${state}`);
      if (state === "failed" || state === "closed") this.onClose?.();
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({ type: "candidate", data: event.candidate });
      }
    };
  }

  private setupDataChannelListeners() {
    if (!this.dc) return;
    this.dc.binaryType = "arraybuffer";
    this.dc.onopen = () => this.onOpen?.();
    this.dc.onclose = () => this.onClose?.();
    this.dc.onmessage = (event) => this.handleDataChannelMessage(event.data);
  }

  private handleDataChannelMessage(data: string | ArrayBuffer) {
    if (typeof data === "string" && data.startsWith(CONTROL_PREFIX)) {
      const control = JSON.parse(
        data.slice(CONTROL_PREFIX.length),
      ) as ControlMessage;

      if (control.kind === "file-meta") {
        this.onFileMeta?.(control);
      } else {
        this.onFileComplete?.(control.id);
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      if (data.byteLength >= CHUNK_HEADER_BYTES) {
        const header = new DataView(data, 0, CHUNK_HEADER_BYTES);
        if (header.getUint32(0) === CHUNK_MAGIC) {
          this.onFileChunk?.({
            index: header.getUint32(4),
            data: data.slice(CHUNK_HEADER_BYTES),
          });
          return;
        }
      }
      this.onMessage?.(data);
      return;
    }

    this.onMessage?.(data);
  }

  private sendControlMessage(message: ControlMessage) {
    if (this.dc?.readyState === "open") {
      this.dc.send(`${CONTROL_PREFIX}${JSON.stringify(message)}`);
    }
  }

  private sendSignal(payload: {
    type: "offer" | "answer" | "candidate";
    data: RTCSessionDescriptionInit | RTCIceCandidate;
  }) {
    if (this.getWs().readyState !== WebSocket.OPEN) return;
    this.getWs().send(
      JSON.stringify({
        ...payload,
        to: this.remotePeerId,
        shardId: this.shardId,
      }),
    );
  }

  private async flushCandidates() {
    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of candidates) {
      await this.pc!.addIceCandidate(candidate);
    }
  }

  private async createAndSendOffer() {
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this.sendSignal({ type: "offer", data: offer });
  }

  private async waitForBufferedAmountLow() {
    if (!this.dc || this.dc.bufferedAmount <= HIGH_WATER_MARK) return;

    await new Promise<void>((resolve) => {
      if (!this.dc) {
        resolve();
        return;
      }

      this.dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
      const handleLow = () => {
        this.dc?.removeEventListener("bufferedamountlow", handleLow);
        resolve();
      };
      this.dc.addEventListener("bufferedamountlow", handleLow);
    });
  }
}
