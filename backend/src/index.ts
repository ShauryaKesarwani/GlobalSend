import { Hono } from "hono";
import { serve } from "bun";
import { websocket } from "hono/bun";
import { wsRoute } from "./ws/index";
import { startCleanupLoop } from "./presence/cleanup";

const app = new Hono();
const port = Number(process.env.PORT) || 4000;

startCleanupLoop();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/ws", wsRoute);

// app.get("all_peers", (c) => {
//   for
// });
console.log(`Server running on http://localhost:${port}`);
serve({
  fetch: app.fetch,
  port: port,
  websocket,
});
