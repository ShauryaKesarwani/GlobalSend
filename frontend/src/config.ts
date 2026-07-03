const required = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001",
  env: process.env.NEXT_PUBLIC_APP_ENV || "development",
  isProduction: process.env.NEXT_PUBLIC_APP_ENV === "production",
  enableAnalytics: process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true",
} as const;

// This ensures your config is deeply read-only
export type EnvConfig = typeof env;
