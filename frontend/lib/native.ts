// Typed bridge to the native app's Rust side (native/src-tauri/src/commands.rs).
// Only call these when isNativeApp() is true; the website never loads Tauri.
import type { UnlistenFn } from "@tauri-apps/api/event";
import { NativeFile, type NativeFileInfo } from "./sendableFile";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux" | "unknown";

export type BackgroundMode = "off" | "reachable" | "alwaysAwake";

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
  /** Android: keep running when the app is closed. */
  backgroundMode: BackgroundMode;
  nfcAutoAccept: boolean;
  lanAutoAccept: boolean;
  canChangeDownloadDir: boolean;
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

/** Bytes per IPC chunk when streaming a page-held File into the LAN engine. */
export const PUSH_CHUNK_BYTES = 512 * 1024;

/** Base64 for IPC: Android's Tauri bridge carries text only, not raw bytes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Feeds files to the engine one chunk at a time, in order. Each push waits
 * until the engine has room, so memory stays flat. An empty chunk ends a file.
 * Returns false if a push failed (transfer declined, cancelled or broken).
 */
export async function pushFiles(
  files: Blob[],
  push: (fileIndex: number, data: string) => Promise<unknown>,
): Promise<boolean> {
  try {
    for (const [index, file] of files.entries()) {
      for (let offset = 0; offset < file.size; offset += PUSH_CHUNK_BYTES) {
        const chunk = new Uint8Array(await file.slice(offset, offset + PUSH_CHUNK_BYTES).arrayBuffer());
        await push(index, toBase64(chunk));
      }
      await push(index, ""); // end of this file
    }
    return true;
  } catch {
    return false;
  }
}

export const native = {
  settings: () => call<AppSettings>("app_settings"),
  setDeviceName: (name: string) => call<string>("set_device_name", { name }),
  setBackgroundMode: (mode: BackgroundMode) => call<void>("set_background_mode", { mode }),
  setAutoAccept: (nfc: boolean, lan: boolean) => call<void>("set_auto_accept", { nfc, lan }),
  /** `null` resets to the default folder. Returns the folder now in use. */
  setDownloadDir: (path: string | null) => call<string>("set_download_dir", { path }),
  async pickFolder(): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  setSignalingId: (id: string | null, siteUrl?: string) =>
    call<void>("set_signaling_id", { id, siteUrl: siteUrl || null }),
  lanPeers: () => call<LanPeer[]>("lan_peers"),
  lanRefresh: () => call<void>("lan_refresh"),
  /** Native files: Rust reads them straight from disk (fastest path). */
  lanSend: (peerId: string, files: NativeFile[], tapToken?: string) =>
    call<string>("lan_send", { peerId, files: files.map(({ path, name }) => ({ path, name })), tapToken: tapToken ?? null }),
  /** Sends files the page holds (picked, dropped or shared) without needing paths. */
  async lanSendWeb(peerId: string, files: File[], tapToken?: string): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    const metas = files.map((f) => ({ name: f.name, size: f.size, mimeType: f.type || "application/octet-stream" }));
    const transferId = await invoke<string>("lan_send_web", { peerId, files: metas, tapToken: tapToken ?? null });
    void pushFiles(files, (fileIndex, data) => invoke("lan_push_chunk", { transferId, fileIndex, data })).then((ok) => {
      // Don't leave the transfer hanging if the page couldn't feed it.
      if (!ok) void invoke("lan_cancel", { transferId });
    });
    return transferId;
  },
  lanRespond: (requestId: string, accept: boolean) => call<boolean>("lan_respond", { requestId, accept }),
  lanCancel: (transferId: string) => call<void>("lan_cancel", { transferId }),
  nfcReadTap: () => call<TapResult>("nfc_read_tap"),
  nfcCancelRead: () => call<void>("nfc_cancel_read"),
  verifyTapToken: (token: string) => call<boolean>("verify_tap_token", { token }),

  /** Native file picker; returns paths (desktop) or content:// URIs (Android). */
  /** Native file picker; returns references to the real files (paths / content:// URIs). */
  async pickFiles(kind: "media" | "any" = "any"): Promise<NativeFile[]> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, directory: false, pickerMode: kind === "media" ? "media" : undefined });
    if (!picked) return [];
    return native.describeFiles(Array.isArray(picked) ? picked : [picked]);
  },

  /** Turns paths (picked, dropped, shared) into sendable file references. */
  async describeFiles(paths: string[]): Promise<NativeFile[]> {
    const infos = await call<NativeFileInfo[]>("describe_files", { paths });
    return infos.map((info) => new NativeFile(info));
  },

  /** Desktop drag-and-drop: the app window receives real paths, not browser files. */
  async onFileDrop(handlers: { hover: (over: boolean) => void; drop: (paths: string[]) => void }): Promise<UnlistenFn> {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") handlers.hover(true);
      else if (payload.type === "leave") handlers.hover(false);
      else {
        handlers.hover(false);
        if (payload.paths.length) handlers.drop(payload.paths);
      }
    });
  },

  async onLanEvent(handler: (event: LanEvent) => void): Promise<UnlistenFn> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<LanEvent>("lan-event", (event) => handler(event.payload));
  },
};
