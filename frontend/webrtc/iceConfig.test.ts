import { afterEach, expect, test } from "bun:test";
import { FALLBACK_ICE, fetchIceConfig, resetIceCache } from "./iceConfig";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetIceCache();
});

test("shares one TURN lookup between shards", async () => {
  let calls = 0;
  globalThis.fetch = (async (url: string) => {
    calls += 1;
    return Response.json(String(url).endsWith("/session") ? { token: "t" } : { iceServers: [{ urls: "turn:x" }], ttl: 60 });
  }) as typeof fetch;
  const configs = await Promise.all([fetchIceConfig(), fetchIceConfig(), fetchIceConfig()]);
  expect(configs[0].iceServers).toEqual([{ urls: "turn:x" }]);
  expect(calls).toBe(2); // one session + one ice-servers request in total
});

test("falls back quickly when the backend is unreachable (offline LAN)", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as unknown as typeof fetch;
  expect(await fetchIceConfig()).toEqual(FALLBACK_ICE);
});

test("gives up on a hanging backend instead of blocking the connection", async () => {
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
  const started = Date.now();
  expect(await fetchIceConfig()).toEqual(FALLBACK_ICE);
  expect(Date.now() - started).toBeLessThan(4500);
});
