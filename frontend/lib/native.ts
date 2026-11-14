// Typed bridge to the native app's Rust side (native/src-tauri/src/commands.rs).
// Only call these when isNativeApp() is true; the website never loads Tauri.
import type { UnlistenFn } from "@tauri-apps/api/event";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux" | "unknown";

export type NfcStatus = { supported: boolean; enabled: boolean; cardEmulation: boolean };

export type AppSettings = {
  deviceId: string;
  deviceName: string | null;
  effectiveName: string;
  defaultName: string;
  platform: Platform;
  downloadDir: string;
  lanPort: number;
  nfc: NfcStatus;
};

export type LanPeer = {
  id: string;
  alias: string;
  platform: Platform;
  address: string;
  port: number;
  signalingId?: string;
};

export type LanFile = { id: string; name: string; size: number; mimeType: string };
export type Direction = "send" | "receive";

export type LanEvent =
  | { type: "peersChanged"; peers: LanPeer[] }
  | { type: "incomingRequest"; requestId: string; from: LanPeer; files: LanFile[]; totalSize: number }
  | { type: "requestResolved"; requestId: string; accepted: boolean }
  | { type: "transferStarted"; transferId: string; direction: Direction; peer: LanPeer; files: LanFile[]; totalSize: number; autoAccepted: boolean }
  | { type: "transferProgress"; transferId: string; direction: Direction; fileId: string; transferred: number; totalSize: number }
  | { type: "fileReceived"; transferId: string; fileId: string; name: string; path: string }
  | { type: "transferFinished"; transferId: string; direction: Direction; ok: boolean; error: string | null };

export type TapPayload = {
  v: number;
  id: string;
  alias: string;
  platform: Platform;
  port: number;
  ips: string[];
  ws?: string;
  token?: string;
};

/** `lanPeer` set: send over LAN. Otherwise fall back to WebRTC via `payload.ws`. */
export type TapResult = { payload: TapPayload; lanPeer: LanPeer | null };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export const native = {
  settings: () => call<AppSettings>("app_settings"),
  setDeviceName: (name: string) => call<string>("set_device_name", { name }),
  setSignalingId: (id: string | null, siteUrl?: string) =>
    call<void>("set_signaling_id", { id, siteUrl: siteUrl || null }),
  lanPeers: () => call<LanPeer[]>("lan_peers"),
  lanRefresh: () => call<void>("lan_refresh"),
  lanSend: (peerId: string, paths: string[], tapToken?: string) =>
    call<string>("lan_send", { peerId, paths, tapToken: tapToken ?? null }),
  lanRespond: (requestId: string, accept: boolean) => call<boolean>("lan_respond", { requestId, accept }),
  lanCancel: (transferId: string) => call<void>("lan_cancel", { transferId }),
  nfcReadTap: () => call<TapResult>("nfc_read_tap"),
  nfcCancelRead: () => call<void>("nfc_cancel_read"),
  verifyTapToken: (token: string) => call<boolean>("verify_tap_token", { token }),

  /** Native file picker; returns paths (desktop) or content:// URIs (Android). */
  async pickFiles(): Promise<string[]> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, directory: false });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  },

  async onLanEvent(handler: (event: LanEvent) => void): Promise<UnlistenFn> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<LanEvent>("lan-event", (event) => handler(event.payload));
  },
};
