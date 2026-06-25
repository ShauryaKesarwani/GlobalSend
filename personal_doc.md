transfer-invite / accept / decline
= app-level UX protocol

offer / answer
= actual WebRTC protocol

clients live in ws/store.ts

zod validation in /validation. ts types in /types

flow
```
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
```

---

### Peer Connection Manager
##### Properties
private pc: RTCPeerConnection | null = null; (made with initAsSender/initAsReceiver functions)
private dc: RTCDataChannel | null = null; (send files through this channel)
private ws: WebSocket;  (ref of ws connection so it can relay message during setups {offer, answer, candidate})
private remotePeerId: string;   (who u connected to)

createPeerConnection() — STUN + ICE setup
createAndSendOffer() — SDP negotiation
setupDataChannelListeners() — wire callbacks

##### Role methods - entry point
initAsSender() — called by person who "send file" after receiving transfer-accept. It creates the DataChannel explicitly and kicks off the offer.
initAsReceiver() — called by the person who just clicked "accept". It sets up 'ondatachannel' to wait for the channel to arrive from the sender's side. It does NOT create the channel itself — only the offerer does that.

DC must exist before createOffer() is called else the channel won't be included in the SDP (Session Description Protocol) blob sent to other peer. only sender should create channel else sync issues will happen.


##### Signal handlers
handleOffer — the receiver calls this. It does three things in order: stores the sender's SDP (setRemoteDescription), generates a reply SDP (createAnswer), stores its own SDP (setLocalDescription), then sends the answer back via WebSocket. The order matters — you must set remote before creating the answer.
handleAnswer — the sender calls this when the receiver's answer arrives. One job: store the receiver's SDP. That completes the exchange.
handleCandidate — both sides call this as ICE candidates arrive from the other peer. Each candidate is a potential network path. The browser tries all of them and picks the best one.

What is setLocalDescription / setRemoteDescription?

Think of SDP as a business card describing your network capabilities. setLocalDescription is "here's my card". setRemoteDescription is "here's the card I received from them". Both sides need both cards before they can talk.

##### Private Internals
createPeerConnection() — both sender and receiver call this, so it's extracted. It does two things: creates the RTCPeerConnection with a STUN server config, and sets onicecandidate. The STUN server (stun.l.google.com) tells  browser what your public IP address looks like from the outside — needed to punch through NAT/routers. Every time the browser finds a new candidate, onicecandidate fires and you immediately relay it to the other peer via ws.
createAndSendOffer() — generates the SDP offer and sends it. Called only by the sender.
setupDataChannelListeners() — wires up the three callbacks (onopen, onclose, onmessage) on the data channel. Called by both sides but at different times — sender calls it immediately after creating the channel, receiver calls it inside ondatachannel when the channel arrives.

*Callbacks*: onOpen · onMessage · onClose

---

The full flow in one sentence per step

User A clicks send → your code sends transfer-invite via WebSocket
User B sees popup, clicks accept → your code sends transfer-accept via WebSocket
User A receives transfer-accept → calls initAsSender() → creates DataChannel → calls createAndSendOffer()
User B receives transfer-accept sent confirmation → calls initAsReceiver() → waits for channel
Server relays offer to B → B calls handleOffer() → sends answer back
Server relays answer to A → A calls handleAnswer()
Both sides fire onicecandidate multiple times → each candidate relayed via server → both call handleCandidate()
Browser picks best network path → DataChannel opens → onOpen fires on both sides
You can now call sendMessage() directly browser-to-browser — server is out of the loop