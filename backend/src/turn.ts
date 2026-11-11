import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = { Bindings: { ip?: string } };
const app = new Hono<Env>();
const sessions = new Map<string, { ip: string; expires: number }>();
const limits = new Map<string, { count: number; expires: number }>();
const hour = 60 * 60 * 1000;
const ttl = 24 * 60 * 60;

// Process-local limits are a fallback; enforce shared limits at the edge in production.
function allow(key: string, max: number) {
  const now = Date.now();
  for (const [k, v] of limits) if (v.expires <= now) limits.delete(k);
  for (const [k, v] of sessions) if (v.expires <= now) sessions.delete(k);
  const current = limits.get(key);
  if (!current) {
    limits.set(key, { count: 1, expires: now + hour });
    return true;
  }
  if (current.count >= max) return false;
  current.count++;
  return true;
}

app.use("*", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type"] }));
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.post("/session", (c) => {
  const ip = c.env?.ip;
  if (!ip) return c.json({ error: "Client address unavailable" }, 503);
  if (!allow(`session:${ip}`, 60)) return c.json({ error: "Rate limit exceeded" }, 429);
  const token = crypto.randomUUID() + crypto.randomUUID();
  sessions.set(token, { ip, expires: Date.now() + 24 * hour });
  return c.json({ token });
});

app.post("/ice-servers", async (c) => {
  const ip = c.env?.ip;
  if (!ip) return c.json({ error: "Client address unavailable" }, 503);
  // Count invalid requests as well, so guessing tokens is rate limited.
  if (!allow(`ice:${ip}`, 60)) return c.json({ error: "Rate limit exceeded" }, 429);
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
  const session = token && sessions.get(token);
  if (!session || session.ip !== ip || session.expires <= Date.now()) {
    return c.json({ error: "Invalid or expired guest session" }, 401);
  }
  if (!allow(`token:${token}`, 30)) return c.json({ error: "Rate limit exceeded" }, 429);
  const key = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
  if (!key || !apiToken) return c.json({ error: "TURN is not configured" }, 503);
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return c.json({ error: "TURN credentials unavailable" }, 502);
    const data = await response.json() as { iceServers?: unknown };
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      return c.json({ error: "Invalid TURN provider response" }, 502);
    }
    return c.json({ iceServers: data.iceServers, ttl });
  } catch {
    return c.json({ error: "TURN credentials unavailable" }, 502);
  }
});

export default app;
