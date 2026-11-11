export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  env: process.env.NEXT_PUBLIC_APP_ENV || "development",
  isProduction: process.env.NEXT_PUBLIC_APP_ENV === "production",
  enableAnalytics: process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true",
} as const;

export const wsUrl = env.apiUrl.replace(/^http/, "ws");

const configuredShardCount = Number.parseInt(
  process.env.NEXT_PUBLIC_TRANSFER_SHARDS || "3",
  10,
);

export const transferShardCount = Number.isFinite(configuredShardCount)
  ? Math.min(4, Math.max(1, configuredShardCount))
  : 3;

// This ensures your config is deeply read-only
export type EnvConfig = typeof env;
