export class PeerConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ws: WebSocket;
  private remotePeerId: string;

  // Callbacks — set these from outside after creating the instance
  onMessage?: (data: string | ArrayBuffer) => void;
  onOpen?: () => void;
  onClose?: () => void;

  constructor(ws: WebSocket, remotePeerId: string) {
    this.ws = ws;
    this.remotePeerId = remotePeerId;
  }

  // Called by sender after receiving transfer-accept
  public initAsSender() {
    this.createPeerConnection();
    this.dc = this.pc!.createDataChannel("file-transfer", { ordered: true });
    this.setupDataChannelListeners();
    this.createAndSendOffer();
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

  // Called when WS receives { type: "answer", data: ..., from: remotePeerId }
  public async handleAnswer(sdp: RTCSessionDescriptionInit) {
    await this.pc!.setRemoteDescription(sdp);
  }

  // Called when WS receives { type: "candidate", data: ..., from: remotePeerId }
  public async handleCandidate(candidate: RTCIceCandidateInit) {
    await this.pc!.addIceCandidate(candidate);
  }

  public sendMessage(data: string | ArrayBuffer) {
    if (this.dc?.readyState === "open") {
      this.dc.send(data as any);
    }
  }

  public close() {
    this.dc?.close();
    this.pc?.close();
    this.pc = null;
    this.dc = null;
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
    this.dc.onopen = () => this.onOpen?.();
    this.dc.onclose = () => this.onClose?.();
    this.dc.onmessage = (e) => this.onMessage?.(e.data);
  }
}
