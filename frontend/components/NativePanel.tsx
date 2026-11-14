"use client";

// Native-app-only controls: device name, LAN "Nearby" devices and NFC tap to
// connect. Temporary home on the /test page until the real UI design lands.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { native, type AppSettings, type LanEvent, type LanPeer, type TapResult } from "@/lib/native";
import { applyTransferEvent, type NativeTransfer } from "@/lib/nativeTransfers";
import { env } from "@/src/config";

type IncomingRequest = Extract<LanEvent, { type: "incomingRequest" }>;
type TappedLanPeer = { peer: LanPeer; token?: string };

const TAP_VALID_MS = 110_000; // Token lives 120 s on the receiver; leave some margin.

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function errorText(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong";
}

type Props = {
  signalingId: string;
  /** Tapped device isn't on this network: continue over WebRTC. */
  onTapRtc: (result: TapResult) => void;
  onLanPeersChange: (peers: LanPeer[]) => void;
  onLog: (message: string) => void;
};

export function NativePanel({ signalingId, onTapRtc, onLanPeersChange, onLog }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [peers, setPeers] = useState<LanPeer[]>([]);
  const [requests, setRequests] = useState<IncomingRequest[]>([]);
  const [transfers, setTransfers] = useState<NativeTransfer[]>([]);
  const [tapWaiting, setTapWaiting] = useState(false);
  const [tapped, setTapped] = useState<TappedLanPeer | null>(null);
  const callbacks = useRef({ onLanPeersChange, onLog });
  useEffect(() => {
    callbacks.current = { onLanPeersChange, onLog };
  }, [onLanPeersChange, onLog]);

  useEffect(() => {
    if (!tapped) return;
    const timer = window.setTimeout(() => setTapped(null), TAP_VALID_MS);
    return () => window.clearTimeout(timer);
  }, [tapped]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void native.settings().then((s) => {
      setSettings(s);
      setNameDraft(s.deviceName ?? s.defaultName);
      setEditingName(s.deviceName === null);
    });
    void native.lanPeers().then((list) => {
      setPeers(list);
      callbacks.current.onLanPeersChange(list);
    });
    void native.onLanEvent((event) => {
      if (event.type === "peersChanged") {
        setPeers(event.peers);
        callbacks.current.onLanPeersChange(event.peers);
      } else if (event.type === "incomingRequest") {
        setRequests((prev) => [...prev, event]);
      } else if (event.type === "requestResolved") {
        setRequests((prev) => prev.filter((r) => r.requestId !== event.requestId));
      } else {
        if (event.type === "transferStarted" && event.direction === "receive" && event.autoAccepted) {
          toast.success(`Receiving from ${event.peer.alias}`, { description: "Accepted automatically after NFC tap" });
        }
        if (event.type === "transferFinished") {
          callbacks.current.onLog(`LAN ${event.direction} ${event.ok ? "finished" : `failed: ${event.error}`}`);
        }
        setTransfers((prev) => applyTransferEvent(prev, event));
      }
    }).then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // The site URL lets browsers and phones without the app tap this phone too.
    void native.setSignalingId(signalingId, env.siteUrl);
    return () => void native.setSignalingId(null);
  }, [signalingId]);

  const saveName = async () => {
    try {
      const name = await native.setDeviceName(nameDraft);
      setSettings((s) => (s ? { ...s, deviceName: name, effectiveName: name } : s));
      setEditingName(false);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const sendTo = async (peer: LanPeer, tapToken?: string) => {
    try {
      const paths = await native.pickFiles();
      if (!paths.length) return;
      await native.lanSend(peer.id, paths, tapToken);
      onLog(`LAN: sending ${paths.length} file(s) to ${peer.alias}${tapToken ? " (tap, no prompt)" : ""}`);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const startTap = async () => {
    setTapWaiting(true);
    try {
      const result = await native.nfcReadTap();
      if (result.lanPeer) {
        setTapped({ peer: result.lanPeer, token: result.payload.token });
        toast.success(`Tapped ${result.payload.alias}`, { description: "Same network: choose files to send" });
      } else if (result.payload.ws) {
        toast.message(`Tapped ${result.payload.alias}`, { description: "Not on this network: connecting over the internet" });
        onTapRtc(result);
      } else {
        toast.error(`${result.payload.alias} isn't on this network and is offline`);
      }
    } catch (error) {
      if (errorText(error) !== "cancelled") toast.error(errorText(error));
    } finally {
      setTapWaiting(false);
    }
  };

  const cancelTap = () => void native.nfcCancelRead();

  const respond = (request: IncomingRequest, accept: boolean) => {
    void native.lanRespond(request.requestId, accept);
    setRequests((prev) => prev.filter((r) => r.requestId !== request.requestId));
  };

  const nfc = settings?.nfc;

  return (
    <div className="rounded-3xl border border-emerald-200 bg-emerald-50/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-stone-900">Nearby (same network)</h2>
        <button onClick={() => void native.lanRefresh()} className="rounded-full border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100">
          Refresh
        </button>
      </div>

      <div className="mt-3 rounded-2xl border border-stone-200 bg-white p-3 text-sm">
        {editingName ? (
          <form onSubmit={(event) => { event.preventDefault(); void saveName(); }} className="flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="device-name">Device name</label>
            <input
              id="device-name"
              value={nameDraft}
              maxLength={40}
              onChange={(event) => setNameDraft(event.target.value)}
              placeholder="Name this device"
              className="min-w-0 flex-1 rounded-xl border border-stone-300 px-3 py-2 outline-none focus:border-stone-500"
            />
            <button type="submit" className="rounded-full bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-700">Save name</button>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span>This device: <strong>{settings?.effectiveName ?? "…"}</strong></span>
            <button onClick={() => setEditingName(true)} className="text-xs text-stone-500 underline">Rename</button>
          </div>
        )}
        {settings?.deviceName === null && (
          <p className="mt-2 text-xs text-stone-500">Pick a name so others can recognise this device.</p>
        )}
      </div>

      {nfc?.supported && (
        <div className="mt-3 rounded-2xl border border-stone-200 bg-white p-3 text-sm">
          {!nfc.enabled ? (
            <p className="text-stone-600">Turn on NFC in system settings to tap phones together.</p>
          ) : tapWaiting ? (
            <div className="flex items-center justify-between gap-2">
              <span>Hold the back of your phone against the other phone…</span>
              <button onClick={cancelTap} className="rounded-full border border-stone-300 px-3 py-1 text-xs">Cancel</button>
            </div>
          ) : tapped ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Tapped <strong>{tapped.peer.alias}</strong>. They won&apos;t need to accept.</span>
              <button
                onClick={() => { void sendTo(tapped.peer, tapped.token); setTapped(null); }}
                className="rounded-full bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
              >
                Choose files
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-stone-600">Tap phones to connect instantly. The other phone just needs to be unlocked.</span>
              <button onClick={() => void startTap()} className="rounded-full bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-700">
                Tap to send
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 space-y-2">
        {peers.length === 0 && (
          <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-5 text-sm text-stone-600">
            No GlobalSend devices found on this network yet. They appear here automatically while the app is open or in the background.
          </p>
        )}
        {peers.map((peer) => (
          <div key={peer.id} className="flex items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white p-3">
            <div>
              <div className="font-medium text-stone-900">{peer.alias}</div>
              <div className="text-xs text-stone-500">{peer.platform} · {peer.address}</div>
            </div>
            <button onClick={() => void sendTo(peer)} className="rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700">
              Send files
            </button>
          </div>
        ))}
      </div>

      {transfers.length > 0 && (
        <div className="mt-4 space-y-2">
          {transfers.slice(0, 6).map((t) => {
            const percent = t.totalSize === 0 ? 100 : Math.min(100, (t.transferred / t.totalSize) * 100);
            return (
              <div key={t.id} className="rounded-2xl border border-stone-200 bg-white p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {t.direction === "send" ? "To" : "From"} {t.peerAlias} · {t.files.length === 1 ? t.files[0].name : `${t.files.length} files`}
                  </span>
                  <span className="text-xs text-stone-500">
                    {t.status === "active" ? `${Math.floor(percent)}%` : t.status === "done" ? "done" : t.error}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(percent)}>
                  <div className={`h-full ${t.status === "failed" ? "bg-red-400" : "bg-emerald-500"}`} style={{ width: `${percent}%` }} />
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-stone-500">
                  <span>{formatBytes(t.transferred)} / {formatBytes(t.totalSize)}{t.autoAccepted ? " · via tap" : ""}</span>
                  {t.status === "active" && (
                    <button onClick={() => void native.lanCancel(t.id)} className="underline">Cancel</button>
                  )}
                </div>
                {t.direction === "receive" && t.status === "done" && t.saved.length > 0 && (
                  <div className="mt-1 break-all text-xs text-stone-500">Saved to {settings?.downloadDir}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {requests[0] && (
        <div role="dialog" aria-live="polite" className="fixed left-1/2 top-4 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-3xl border border-emerald-300/50 bg-stone-950 p-5 text-stone-100 shadow-2xl">
          <div className="font-medium">
            {requests[0].from.alias} wants to send {requests[0].files.length === 1 ? requests[0].files[0].name : `${requests[0].files.length} files`}
          </div>
          <div className="mt-1 text-sm text-stone-300">{formatBytes(requests[0].totalSize)} · over your local network</div>
          <div className="mt-4 flex gap-2">
            <button onClick={() => respond(requests[0], true)} className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400">Accept</button>
            <button onClick={() => respond(requests[0], false)} className="rounded-full border border-stone-500 px-4 py-2 text-sm hover:bg-stone-800">Decline</button>
          </div>
        </div>
      )}
    </div>
  );
}
