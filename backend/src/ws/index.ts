import { upgradeWebSocket } from "hono/bun";
import { peers } from "../presence/store";
import { removePeer } from "../presence/cleanup";
import { messageSchema } from "../validation/message";
import { clients } from "./store";
import { clientIp, networkKey } from "../presence/network";

type Bindings = { ip?: string };

function peerView(viewerNetwork: string | null, id: string, peer: { alias: string; network: string | null }) {
  const nearby = viewerNetwork !== null && peer.network === viewerNetwork;
  return { id, alias: peer.alias, nearby };
}

export const wsRoute = upgradeWebSocket((c) => {
  const id = c.req.query("id")!;
  const network = networkKey(clientIp(c.req.raw.headers, (c.env as Bindings | undefined)?.ip));

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
          peers.set(id, { alias: data.alias, lastSeen: Date.now(), network });

          // `nearby` is relative to each recipient, so peer_joined is sent per client.
          for (const [otherId, client] of clients) {
            const viewer = peers.get(otherId);
            client.send(JSON.stringify({
              type: "peer_joined",
              peer: peerView(viewer?.network ?? null, id, { alias: data.alias, network }),
            }));
          }

          ws.send(
            JSON.stringify({
              type: "peer_list",
              peers: [...peers.entries()].map(([peerId, peer]) => peerView(network, peerId, peer)),
            }),
          );
          break;

        case "heartbeat": {
          const peer = peers.get(id);
          if (peer) peer.lastSeen = Date.now();
          break;
        }

        case "offer":
        case "answer":
        case "candidate":
        case "transfer-invite":
        case "transfer-accept":
        case "transfer-decline": {
          const target = clients.get(data.to);
          if (target) {
            target.send(JSON.stringify({ ...data, from: id }));
          } else {
            console.warn("Target not found:", data.to);
          }
          break;
        }
      }
    },

    onClose() {
      console.log("CLOSE:", id);
      removePeer(id);
    },
  };
});
