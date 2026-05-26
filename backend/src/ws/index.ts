import { upgradeWebSocket } from "hono/bun";
import { messageSchema } from "../validation/message";
import { peers } from "../presence/store";
import { broadcast } from "../presence/broadcast";
import { clients } from "./store";

export const wsRoute = upgradeWebSocket((c) => {
  const id = c.req.query("id")!;

  return {
    onOpen(_, ws) {
      clients.set(id, ws);
      console.log("OPEN:", id);
    },

    onMessage(event, ws) {
      if (typeof event.data !== "string") return;

      const raw = JSON.parse(event.data);
      const result = messageSchema.safeParse(raw);

      if (!result.success) {
        console.error("Invalid message:", result.error);
        return;
      }

      const data = result.data;
      console.log("Incoming:", data);

      switch (data.type) {
        case "join":
          clients.set(id, ws);
          peers.set(id, { alias: data.alias, lastSeen: Date.now() });

          broadcast({ type: "peer_joined", peer: { id, alias: data.alias } });

          ws.send(
            JSON.stringify({
              type: "peer_list",
              peers: [...peers.entries()].map(([peerId, peer]) => ({
                id: peerId,
                alias: peer.alias,
              })),
            }),
          );
          break;

        case "heartbeat":
          const peer = peers.get(id);
          if (peer) peer.lastSeen = Date.now();
          break;

        case "offer":
        case "answer":
        case "candidate":
        case "transfer-invite":
        case "transfer-accept":
        case "transfer-decline":
          const target = clients.get(data.to);
          if (target) {
            target.send(JSON.stringify({ ...data, from: id }));
          } else {
            console.warn("Target not found:", data.to);
          }
          break;
      }
    },

    onClose() {
      clients.delete(id);
      console.log("CLOSE:", id);
    },
  };
});
