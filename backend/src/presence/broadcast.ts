import { clients } from "../ws/store";

export function broadcast(message: unknown) {
  const json = JSON.stringify(message);

  for (const [, client] of clients) {
    client.send(json);
  }
}
