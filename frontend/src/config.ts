export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  env: process.env.NEXT_PUBLIC_APP_ENV || "development",
  isProduction: process.env.NEXT_PUBLIC_APP_ENV === "production",
  enableAnalytics: process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true",
} as const;

export const wsUrl = env.apiUrl.replace(/^http/, "ws");

const parseUrls = (value: string | undefined) => (value || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const stunUrls = parseUrls(process.env.NEXT_PUBLIC_STUN_URLS);
const turnUrls = parseUrls(process.env.NEXT_PUBLIC_TURN_URLS);

export const iceServers: RTCIceServer[] = [
  ...(stunUrls.length > 0
    ? stunUrls.map((url) => ({ urls: url }))
    : [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ]),
  ...(turnUrls.length > 0 &&
  process.env.NEXT_PUBLIC_TURN_USERNAME &&
  process.env.NEXT_PUBLIC_TURN_CREDENTIAL
    ? turnUrls.map((url) => ({
        urls: url,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME,
        credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
      }))
    : []),
];

export const iceTransportPolicy: RTCIceTransportPolicy =
  process.env.NEXT_PUBLIC_ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all";

const configuredShardCount = Number.parseInt(
  process.env.NEXT_PUBLIC_TRANSFER_SHARDS || "3",
  10,
);

export const transferShardCount = Number.isFinite(configuredShardCount)
  ? Math.min(4, Math.max(1, configuredShardCount))
  : 3;

// This ensures your config is deeply read-only
export type EnvConfig = typeof env;
