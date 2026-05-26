import { Hono } from "hono";
import { serve } from "bun";
import { websocket } from "hono/bun";
import { wsRoute } from "./ws/index";
import { startCleanupLoop } from "./presence/cleanup";

const app = new Hono();

startCleanupLoop();

app.get("/ws", wsRoute);

// app.get("all_peers", (c) => {
//   for
// });

serve({
  fetch: app.fetch,
  port: 3001,
  websocket,
});
