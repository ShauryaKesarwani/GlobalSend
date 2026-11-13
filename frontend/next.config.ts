import type { NextConfig } from "next";

// `bun run build:tauri` sets TAURI_BUILD=1 to produce a static export in `out/`
// that the native app bundles, so the UI loads instantly and offline.
const isTauriBuild = process.env.TAURI_BUILD === "1";

const nextConfig: NextConfig = {
  ...(isTauriBuild && {
    output: "export",
    trailingSlash: true,
    images: { unoptimized: true },
  }),
};

export default nextConfig;
