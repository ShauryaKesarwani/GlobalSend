import { afterEach, describe, expect, test } from "bun:test";
import app from "./turn";

const originalFetch = globalThis.fetch;
const originalKey = process.env.CLOUDFLARE_TURN_KEY_ID;
const originalToken = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.CLOUDFLARE_TURN_KEY_ID = originalKey;
  process.env.CLOUDFLARE_TURN_KEY_API_TOKEN = originalToken;
});

describe("TURN credentials", () => {
  test("requires a guest session bound to the client IP", async () => {
    const unauthorized = await app.request("/ice-servers", { method: "POST" }, { ip: "test-auth" });
    expect(unauthorized.status).toBe(401);
    const session = await app.request("/session", { method: "POST" }, { ip: "test-auth" });
    const { token } = await session.json();
    const wrongIp = await app.request("/ice-servers", { method: "POST", headers: { Authorization: `Bearer ${token}` } }, { ip: "test-other" });
    expect(wrongIp.status).toBe(401);
  });

  test("returns the provider's ICE servers without exposing its token", async () => {
    process.env.CLOUDFLARE_TURN_KEY_ID = "key";
    process.env.CLOUDFLARE_TURN_KEY_API_TOKEN = "secret";
    globalThis.fetch = (async (url, options) => {
      expect(String(url)).toContain("/keys/key/credentials/generate-ice-servers");
      expect((options?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
      return Response.json({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "user", credential: "pass" }] }, { status: 201 });
    }) as typeof fetch;
    const session = await app.request("/session", { method: "POST" }, { ip: "test-success" });
    const { token } = await session.json();
    const response = await app.request("/ice-servers", { method: "POST", headers: { Authorization: `Bearer ${token}` } }, { ip: "test-success" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "user", credential: "pass" }], ttl: 86400 });
  });

  test("limits session creation per IP", async () => {
    for (let i = 0; i < 60; i++) expect((await app.request("/session", { method: "POST" }, { ip: "test-limit" })).status).toBe(200);
    expect((await app.request("/session", { method: "POST" }, { ip: "test-limit" })).status).toBe(429);
  });
});
