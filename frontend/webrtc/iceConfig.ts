import { env } from "@/src/config";

export type IceConfig = { iceServers: RTCIceServer[]; ttl: number };

/** Used when TURN is unavailable (offline LAN, backend without TURN keys). Host
 * candidates still connect peers on the same network; STUN helps across NATs. */
export const FALLBACK_ICE: IceConfig = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], ttl: 3600 };

/** Never hold up a connection longer than this waiting for TURN credentials. */
const ICE_FETCH_TIMEOUT_MS = 3000;
/** After a failure, retry TURN on the next connection after this long. */
const FAILURE_RETRY_MS = 30_000;

let cached: { config: Promise<IceConfig>; expires: number } | null = null;

/**
 * ICE servers for a new connection. All shards and peers share one lookup, and
 * a slow or unreachable backend/TURN provider falls back quickly, so LAN
 * connections never wait on the internet.
 */
export function fetchIceConfig(): Promise<IceConfig> {
  if (cached && cached.expires > Date.now()) return cached.config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICE_FETCH_TIMEOUT_MS);
  const entry = {
    expires: Date.now() + FAILURE_RETRY_MS,
    config: fetchTurnConfig(controller.signal)
      .then(
        (config) => {
          entry.expires = Date.now() + config.ttl * 800; // refresh before credentials expire
          return withStun(config);
        },
        () => FALLBACK_ICE,
      )
      .finally(() => clearTimeout(timer)),
  };
  cached = entry;
  return entry.config;
}

/**
 * Makes sure a STUN server is always listed next to TURN. ICE prefers direct and
 * STUN paths and only relays through TURN when those fail, so this keeps
 * TURN (limited free tier) as a last resort.
 */
export function withStun(config: IceConfig): IceConfig {
  const urls = config.iceServers.flatMap((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]));
  if (urls.some((url) => url.startsWith("stun:") || url.startsWith("stuns:"))) return config;
  return { ...config, iceServers: [...FALLBACK_ICE.iceServers, ...config.iceServers] };
}

/** Test hook. */
export function resetIceCache() {
  cached = null;
}

export async function fetchTurnConfig(signal?: AbortSignal): Promise<IceConfig> {
  const session = await fetch(`${env.apiUrl}/api/session`, { method: "POST", cache: "no-store", signal });
  if (!session.ok) throw new Error(`Guest session failed (${session.status})`);
  const { token } = await session.json();
  const response = await fetch(`${env.apiUrl}/api/ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`ICE configuration failed (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data.iceServers) || !data.iceServers.length || typeof data.ttl !== "number" || data.ttl <= 0) {
    throw new Error("Invalid ICE configuration");
  }
  return data;
}
