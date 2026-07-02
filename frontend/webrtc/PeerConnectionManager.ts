const CONTROL_PREFIX = "__rift_ctrl__";
const CHUNK_SIZE = 64 * 1024;

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
};

export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ws: WebSocket;
  private remotePeerId: string;
  private incomingTransfer: IncomingTransfer | null = null;

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
    blob: Blob;
  }) => void;
  onLog?: (message: string) => void;

  constructor(ws: WebSocket, remotePeerId: string) {
    this.ws = ws;
    this.remotePeerId = remotePeerId;
  }

  public initAsSender() {
    this.createPeerConnection();
    this.dc = this.pc!.createDataChannel("file-transfer", { ordered: true });
    this.setupDataChannelListeners();
    void this.createAndSendOffer();
  }

  public initAsReceiver() {
    this.createPeerConnection();
    this.pc!.ondatachannel = (event) => {
      this.dc = event.channel;
      this.setupDataChannelListeners();
    };
  }

  public async handleOffer(sdp: RTCSessionDescriptionInit) {
    await this.pc!.setRemoteDescription(sdp);
    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    this.ws.send(
      JSON.stringify({
        type: "answer",
        to: this.remotePeerId,
        data: answer,
      }),
    );
  }

  public async handleAnswer(sdp: RTCSessionDescriptionInit) {
    await this.pc!.setRemoteDescription(sdp);
  }

  public async handleCandidate(candidate: RTCIceCandidateInit) {
    await this.pc!.addIceCandidate(candidate);
  }

  public sendMessage(data: string | ArrayBuffer) {
    if (this.dc?.readyState === "open") {
      this.dc.send(data as string | ArrayBufferLike | Blob | ArrayBufferView);
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
    const chunkCount = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    this.sendControlMessage({
      kind: "file-meta",
      id: transferId,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      chunkSize: CHUNK_SIZE,
      chunkCount,
    });

    let offset = 0;
    while (offset < file.size) {
      await this.waitForBufferedAmountLow();
      const nextChunk = file.slice(offset, offset + CHUNK_SIZE);
      const chunkBuffer = await nextChunk.arrayBuffer();
      this.dc.send(chunkBuffer);
      offset += chunkBuffer.byteLength;
      handlers?.onProgress?.(offset, file.size);
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
  }

  private createPeerConnection() {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(
          JSON.stringify({
            type: "candidate",
            to: this.remotePeerId,
            data: event.candidate,
          }),
        );
      }
    };
  }

  private async createAndSendOffer() {
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this.ws.send(
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

      if (!this.incomingTransfer || this.incomingTransfer.meta.id !== control.id) {
        this.onLog?.("Ignoring file completion for unknown transfer");
        return;
      }

      const { meta, buffers, receivedBytes } = this.incomingTransfer;
      if (receivedBytes !== meta.size) {
        this.onLog?.(
          `Transfer ${meta.name} ended with ${receivedBytes}/${meta.size} bytes`,
        );
      }

      const blob = new Blob(buffers, {
        type: meta.mimeType || "application/octet-stream",
      });
      this.onFileComplete?.({
        id: meta.id,
        name: meta.name,
        mimeType: meta.mimeType,
        size: receivedBytes,
        blob,
      });
      this.incomingTransfer = null;
      return;
    }

    if (data instanceof ArrayBuffer && this.incomingTransfer) {
      this.incomingTransfer.buffers.push(data);
      this.incomingTransfer.receivedBytes += data.byteLength;
      this.onFileProgress?.({
        id: this.incomingTransfer.meta.id,
        receivedBytes: this.incomingTransfer.receivedBytes,
        totalBytes: this.incomingTransfer.meta.size,
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

    const highWaterMark = 4 * CHUNK_SIZE;
    const lowWaterMark = 2 * CHUNK_SIZE;

    if (this.dc.bufferedAmount <= highWaterMark) return;

    await new Promise<void>((resolve) => {
      if (!this.dc) {
        resolve();
        return;
      }

      this.dc.bufferedAmountLowThreshold = lowWaterMark;
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
}
