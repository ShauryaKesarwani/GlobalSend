import { broadcast } from "./broadcast";
import { peers } from "./store";
import { clients } from "../ws/store";

export function removePeer(id: string) {
  const hadPeer = peers.delete(id);
  clients.delete(id);

  if (hadPeer) {
    console.log("Removed peer:", id);
    broadcast({
      type: "peer_left",
      id,
    });
  }
}

export function startCleanupLoop() {
  setInterval(() => {
    const now = Date.now();

    for (const [id, peer] of peers) {
      const dead = now - peer.lastSeen > 45_000;
      if (!dead) continue;

      const socket = clients.get(id);
      socket?.close();
      removePeer(id);
    }
  }, 10_000);
}
