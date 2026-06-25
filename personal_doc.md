transfer-invite / accept / decline
= app-level UX protocol

offer / answer
= actual WebRTC protocol

clients live in ws/store.ts

zod validation in /validation. ts types in /types

flow
Sender
  |
  | transfer-invite
  v
Receiver
  |
  | transfer-accept
  v
Sender creates offer
  |
  | offer
  v
Receiver
  |
  | answer
  v
ICE exchange
  |
DataChannel opens
  |
Actual P2P transfer