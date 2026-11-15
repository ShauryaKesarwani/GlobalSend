import type { NextConfig } from "next";

// `bun run build:tauri` sets TAURI_BUILD=1 to produce a static export in `out/`
// that the native app bundles, so the UI loads instantly and offline.
const isTauriBuild = process.env.TAURI_BUILD === "1";

const nextConfig: NextConfig = {
  // Dev server only: let phones on the LAN, the Android app's dev webview and
  // HTTPS tunnels (Tailscale Funnel, Cloudflare) load hot reload and dev assets.
  // tauri.localhost is the Android app's webview origin in `tauri android dev`.
  allowedDevOrigins: ["192.168.*.*", "**.ts.net", "tauri.localhost"],
  ...(isTauriBuild && {
    output: "export",
    trailingSlash: true,
    images: { unoptimized: true },
  }),
};

export default nextConfig;
