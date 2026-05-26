import { peers } from "./store";
import { broadcast } from "./broadcast";
import { clients } from "../ws/store";

export function startCleanupLoop() {
  setInterval(() => {
    const now = Date.now();

    for (const [id, peer] of peers) {
      const dead = now - peer.lastSeen > 500000;
      if (dead) {
        const socket = clients.get(id);
        socket?.close();

        peers.delete(id);
        clients.delete(id);
        console.log("Removed dead peer:", id);

        broadcast({
          type: "peer_leave",
          id,
        });
      }
    }
  }, 10000);
}
