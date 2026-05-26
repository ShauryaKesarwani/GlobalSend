export type WSMessage =
  | JoinMessage
  | HeartbeatMessage
  | OfferMessage
  | AnswerMessage
  | CandidateMessage
  | TransferInviteMessage
  | TransferAcceptMessage
  | TransferDeclineMessage;

export type JoinMessage = {
  type: "join";
  alias: string;
};

export type HeartbeatMessage = {
  type: "heartbeat";
};

export type OfferMessage = {
  type: "offer";
  to: string;
  data: RTCSessionDescriptionInit;
};

export type AnswerMessage = {
  type: "answer";
  to: string;
  data: RTCSessionDescriptionInit;
};

export type CandidateMessage = {
  type: "candidate";
  to: string;
  data: RTCIceCandidateInit;
};

// --- transfer handshake ---
export type TransferFile = {
  name: string;
  size: number;
  mimeType: string;
};

export type TransferInviteMessage = {
  type: "transfer-invite";
  to: string;
  file: TransferFile;
};

export type TransferAcceptMessage = {
  type: "transfer-accept";
  to: string;
};

export type TransferDeclineMessage = {
  type: "transfer-decline";
  to: string;
};
