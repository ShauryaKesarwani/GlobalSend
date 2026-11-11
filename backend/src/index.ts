import { Hono } from "hono";
import { serve } from "bun";
import { websocket } from "hono/bun";
import { wsRoute } from "./ws/index";
import { startCleanupLoop } from "./presence/cleanup";
import turnRoutes from "./turn";

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
app.route("/api", turnRoutes);

// app.get("all_peers", (c) => {
//   for
// });
console.log(`Server running on http://localhost:${port}`);
serve({
  fetch: (request, server) => app.fetch(request, { ip: server.requestIP(request)?.address }),
  port: port,
  websocket,
});
