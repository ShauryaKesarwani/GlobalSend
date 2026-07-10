const CONTROL_PREFIX = "__rift_ctrl__";
const CHUNK_SIZE = 256 * 1024; //256kb

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
  }

  // Called when WS receives { type: "candidate", data: ..., from: remotePeerId }
  public async handleCandidate(candidate: RTCIceCandidateInit) {
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

  public isOpen() {
    return this.dc?.readyState === "open";
  }

  private createPeerConnection() {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
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

    const highWaterMark = 32 * CHUNK_SIZE;
    const lowWaterMark = 16 * CHUNK_SIZE;

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
