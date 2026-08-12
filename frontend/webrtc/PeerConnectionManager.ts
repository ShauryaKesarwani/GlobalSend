import { iceServers } from "@/src/config";

const CONTROL_PREFIX = "__rift_ctrl__";
const CHUNK_SIZE = 256 * 1024; //256kb
const MAX_READ_AHEAD = 4;
const HIGH_WATER_MARK = 8 * 1024 * 1024;
const LOW_WATER_MARK = 4 * 1024 * 1024;

type FileManifest = {
  kind: "file-meta";
  id: string;
  name: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
};

type FileComplete = {
  kind: "file-complete";
  id: string;
};

type ControlMessage = FileManifest | FileComplete;

type IncomingTransfer = {
  meta: FileManifest;
  buffers: ArrayBuffer[];
  receivedBytes: number;
  sink: FileSystemWritableFileStream | null;
  sinkReady: Promise<FileSystemWritableFileStream | null>;
  writeChain: Promise<void>;
};

export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private remotePeerId: string;
  private incomingTransfer: IncomingTransfer | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  onMessage?: (data: string | ArrayBuffer) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onFileStart?: (meta: {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    chunkCount: number;
  }) => void;
  onFileProgress?: (progress: {
    id: string;
    receivedBytes: number;
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

  constructor(private getWs: () => WebSocket, remotePeerId: string) {
    this.remotePeerId = remotePeerId;
  }

  // Called by sender after receiving transfer-accept
  public initAsSender() {
    this.createPeerConnection();
    this.dc = this.pc!.createDataChannel("file-transfer", { ordered: true });
    this.setupDataChannelListeners();
    void this.createAndSendOffer();
  }

  // Called by receiver after sending transfer-accept
  public initAsReceiver() {
    this.createPeerConnection();
    this.pc!.ondatachannel = (event) => {
      this.dc = event.channel;
      this.setupDataChannelListeners();
    };
  }

  // Called when WS receives { type: "offer", data: ..., from: remotePeerId }
  // Called by receiver after receiving offer
  public async handleOffer(sdp: RTCSessionDescriptionInit) {
    await this.pc!.setRemoteDescription(sdp);
    this.remoteDescriptionSet = true;
    await this.flushCandidates();
    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    this.getWs().send(
      JSON.stringify({
        type: "answer",
        to: this.remotePeerId,
        data: answer,
      }),
    );
  }

  // Called when WS receives { type: "answer", data: ..., from: remotePeerId }
  // Called by sender after receiving answer
  public async handleAnswer(sdp: RTCSessionDescriptionInit) {
    await this.pc!.setRemoteDescription(sdp);
    this.remoteDescriptionSet = true;
    await this.flushCandidates();
  }

  // Called when WS receives { type: "candidate", data: ..., from: remotePeerId }
  public async handleCandidate(candidate: RTCIceCandidateInit) {
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc!.addIceCandidate(candidate);
  }

  // Called by sender/receiver to send arbitrary data (first if data checks string & second for ArrayBuffer auto done by ts)
  public sendMessage(data: string | ArrayBuffer) {
    if (this.dc?.readyState !== "open") return;
    if (typeof data === "string") {
      this.dc.send(data);
    } else {
      this.dc.send(data);
    }
  }

  public async sendFile(
    file: File,
    handlers?: {
      onProgress?: (sentBytes: number, totalBytes: number) => void;
    },
  ) {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error("Data channel is not open");
    }

    const transferId = crypto.randomUUID();
    const chunkSize = this.getChunkSize();
    const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));

    this.sendControlMessage({
      kind: "file-meta",
      id: transferId,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
       chunkSize,
      chunkCount,
    });

    const chunks: Array<{ offset: number; buffer: Promise<ArrayBuffer> }> = [];
    let nextOffset = 0;
    let sentOffset = 0;

    const queueChunk = () => {
      if (nextOffset >= file.size) return;
      const offset = nextOffset;
      nextOffset += Math.min(chunkSize, file.size - offset);
      chunks.push({
        offset,
        buffer: file.slice(offset, nextOffset).arrayBuffer(),
      });
    };

    while (chunks.length < MAX_READ_AHEAD && nextOffset < file.size) {
      queueChunk();
    }

    while (chunks.length > 0) {
      await this.waitForBufferedAmountLow();
      const chunk = chunks.shift()!;
      const chunkBuffer = await chunk.buffer;
      this.dc.send(chunkBuffer);
      sentOffset += chunkBuffer.byteLength;
      handlers?.onProgress?.(sentOffset, file.size);
      queueChunk();
    }

    this.sendControlMessage({
      kind: "file-complete",
      id: transferId,
    });
  }

  public close() {
    this.dc?.close();
    this.pc?.close();
    this.pc = null;
    this.dc = null;
    this.incomingTransfer = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
  }

  public isOpen() {
    return this.dc?.readyState === "open";
  }

  private createPeerConnection() {
    this.pc = new RTCPeerConnection({
      iceServers,
    });

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (!state) return;

      this.onLog?.(`Peer connection state: ${state}`);
      if (state === "failed" || state === "closed") {
        this.onClose?.();
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.getWs().send(
          JSON.stringify({
            type: "candidate",
            to: this.remotePeerId,
            data: event.candidate,
          }),
        );
      }
    };
  }

  private async flushCandidates() {
    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of candidates) {
      await this.pc!.addIceCandidate(candidate);
    }
  }

  private getChunkSize() {
    const maxMessageSize = this.pc?.sctp?.maxMessageSize;
    if (!maxMessageSize || !Number.isFinite(maxMessageSize)) return CHUNK_SIZE;
    return Math.max(16 * 1024, Math.min(CHUNK_SIZE, maxMessageSize));
  }

  private async createAndSendOffer() {
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this.getWs().send(
      JSON.stringify({
        type: "offer",
        to: this.remotePeerId,
        data: offer,
      }),
    );
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
        this.incomingTransfer = {
          meta: control,
          buffers: [],
          receivedBytes: 0,
          sink: null,
          sinkReady: this.openFileSink(control),
          writeChain: Promise.resolve(),
        };
        this.onFileStart?.({
          id: control.id,
          name: control.name,
          mimeType: control.mimeType,
          size: control.size,
          chunkCount: control.chunkCount,
        });
        return;
      }

      if (
        !this.incomingTransfer ||
        this.incomingTransfer.meta.id !== control.id
      ) {
        this.onLog?.("Ignoring file completion for unknown transfer");
        return;
      }

      const transfer = this.incomingTransfer;
      const { meta, buffers, receivedBytes } = transfer;
      if (receivedBytes !== meta.size) {
        this.onLog?.(
          `Transfer ${meta.name} ended with ${receivedBytes}/${meta.size} bytes`,
        );
      }

      void (async () => {
        await transfer.writeChain;
        const sink = await transfer.sinkReady;
        if (sink) await sink.close();
        const blob = sink
          ? undefined
          : new Blob(buffers, {
              type: meta.mimeType || "application/octet-stream",
            });
        this.onFileComplete?.({
          id: meta.id,
          name: meta.name,
          mimeType: meta.mimeType,
          size: receivedBytes,
          blob,
          savedToDisk: Boolean(sink),
        });
      })();
      this.incomingTransfer = null;
      return;
    }

    if (data instanceof ArrayBuffer && this.incomingTransfer) {
      const transfer = this.incomingTransfer;
      transfer.receivedBytes += data.byteLength;
      transfer.writeChain = transfer.writeChain.then(async () => {
        const sink = await transfer.sinkReady;
        if (sink) {
          await sink.write(new Uint8Array(data));
          transfer.sink = sink;
        } else {
          transfer.buffers.push(data);
        }
      });
      this.onFileProgress?.({
        id: transfer.meta.id,
        receivedBytes: transfer.receivedBytes,
        totalBytes: transfer.meta.size,
      });
      return;
    }

    this.onMessage?.(data);
  }

  private sendControlMessage(message: ControlMessage) {
    this.dc?.send(`${CONTROL_PREFIX}${JSON.stringify(message)}`);
  }

  private async waitForBufferedAmountLow() {
    if (!this.dc) return;

    if (this.dc.bufferedAmount <= HIGH_WATER_MARK) return;

    await new Promise<void>((resolve) => {
      if (!this.dc) {
        resolve();
        return;
      }

      this.dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
      const handleLow = () => {
        if (!this.dc) {
          resolve();
          return;
        }

        this.dc.removeEventListener("bufferedamountlow", handleLow);
        resolve();
      };

      this.dc.addEventListener("bufferedamountlow", handleLow);
    });
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
