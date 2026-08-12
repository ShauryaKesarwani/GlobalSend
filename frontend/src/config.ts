const required = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  env: process.env.NEXT_PUBLIC_APP_ENV || "development",
  isProduction: process.env.NEXT_PUBLIC_APP_ENV === "production",
  enableAnalytics: process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true",
} as const;

export const wsUrl = env.apiUrl.replace(/^http/, "ws");

const turnUrls = (process.env.NEXT_PUBLIC_TURN_URLS || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

export const iceServers: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  ...(turnUrls.length > 0 &&
  process.env.NEXT_PUBLIC_TURN_USERNAME &&
  process.env.NEXT_PUBLIC_TURN_CREDENTIAL
    ? [{
        urls: turnUrls,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME,
        credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
      }]
    : []),
];

// This ensures your config is deeply read-only
export type EnvConfig = typeof env;
