import { env } from "@/src/config";

export async function fetchIceConfig(): Promise<{ iceServers: RTCIceServer[]; ttl: number }> {
  try {
    return await fetchTurnConfig();
  } catch {
    // TURN is optional; direct connections can still use Cloudflare STUN.
    return { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], ttl: 3600 };
  }
}

export async function fetchTurnConfig(): Promise<{ iceServers: RTCIceServer[]; ttl: number }> {
  const session = await fetch(`${env.apiUrl}/api/session`, { method: "POST", cache: "no-store" });
  if (!session.ok) throw new Error(`Guest session failed (${session.status})`);
  const { token } = await session.json();
  const response = await fetch(`${env.apiUrl}/api/ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`ICE configuration failed (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data.iceServers) || !data.iceServers.length || typeof data.ttl !== "number" || data.ttl <= 0) {
    throw new Error("Invalid ICE configuration");
  }
  return data;
}
