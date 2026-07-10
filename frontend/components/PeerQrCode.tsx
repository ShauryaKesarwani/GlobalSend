"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { buildPeerConnectUrl } from "@/lib/peerDeepLink";

type PeerQrCodeProps = {
  peerId: string;
  alias: string;
};

const subscribeToOrigin = () => () => undefined;
const getBrowserOrigin = () => window.location.origin;
const getServerOrigin = () => "";

export function PeerQrCode({ peerId, alias }: PeerQrCodeProps) {
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    getBrowserOrigin,
    getServerOrigin,
  );
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const shareUrl = origin
    ? buildPeerConnectUrl({ origin, peerId, alias })
    : "";

  useEffect(() => {
    if (!shareUrl) return;

    let isCurrent = true;

    QRCode.toDataURL(shareUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 6,
      color: {
        dark: "#1c1917",
        light: "#ffffff",
      },
    })
      .then((dataUrl) => {
        if (!isCurrent) return;
        setQrDataUrl(dataUrl);
        setError("");
      })
      .catch(() => {
        if (isCurrent) setError("Could not generate QR code.");
      });

    return () => {
      isCurrent = false;
    };
  }, [shareUrl]);

  const copyShareUrl = async () => {
    if (!shareUrl) return;

    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700 shadow-sm">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex h-32 w-32 items-center justify-center rounded-2xl bg-stone-50 p-2">
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- QR data URLs are generated client-side.
            <img src={qrDataUrl} alt={`QR code to connect to ${alias}`} className="h-full w-full" />
          ) : (
            <span className="text-center text-xs text-stone-500">
              {error || "Generating QR..."}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="font-semibold text-stone-900">Your QR connection code</div>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              Scan this from another device to open /test and auto-send a connection invite to this peer.
            </p>
          </div>

          <div className="break-all rounded-xl bg-stone-50 px-3 py-2 font-mono text-[11px] text-stone-500">
            {shareUrl || "Preparing link..."}
          </div>

          <button
            type="button"
            onClick={() => void copyShareUrl()}
            disabled={!shareUrl}
            className="rounded-full border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 transition enabled:hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      </div>
    </div>
  );
}
