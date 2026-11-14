import { isIP } from "node:net";

/**
 * Groups clients by the network they connect from, so peers behind the same
 * router can be shown as "nearby" (WebRTC then connects them directly over the
 * LAN). Only this opaque key is stored; IP addresses are never sent to clients.
 *
 * - IPv4: the public address (everyone behind one NAT shares it).
 * - IPv6: the /64 prefix (one LAN normally gets one /64).
 * - Loopback / private addresses: one shared "local" network in development. In
 *   production they mean a proxy hides the real address (set TRUST_PROXY=1), so
 *   they never count as nearby there.
 */
export function networkKey(ip: string | undefined | null): string | null {
  if (!ip) return null;
  let address = ip.trim();
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) address = address.slice(7);

  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    const isPrivate = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    return isPrivate ? localKey() : `v4:${address}`;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return localKey();
    return `v6:${expandIPv6(lower).slice(0, 4).join(":")}`;
  }
  return null;
}

function localKey() {
  return process.env.NODE_ENV === "production" ? null : "local";
}

function expandIPv6(address: string): string[] {
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  return [...left, ...Array(Math.max(0, missing)).fill("0"), ...right].map((part) => part.padStart(4, "0"));
}

/**
 * Client address for a request. Behind a reverse proxy (nginx, Cloudflare) set
 * TRUST_PROXY=1 so the forwarded address is used instead of the proxy's.
 */
export function clientIp(headers: Headers, socketIp: string | undefined): string | undefined {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0];
    if (forwarded?.trim()) return forwarded.trim();
  }
  return socketIp;
}
