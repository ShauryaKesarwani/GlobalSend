"use client";

import { useEffect } from "react";
import { isNativeApp } from "@/lib/platform";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    // The native app already bundles its assets; a service worker would only
    // serve stale files after app updates.
    if (isNativeApp()) return;
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(console.error);
    }
  }, []);
  return null;
}
