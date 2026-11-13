import type { MetadataRoute } from "next";

// Required for the static export used by the native app build.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/test",
    },
  };
}
