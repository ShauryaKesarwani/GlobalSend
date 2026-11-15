import type { Direction, LanEvent, LanFile } from "./native";

export type NativeTransfer = {
  id: string;
  direction: Direction;
  peerAlias: string;
  files: LanFile[];
  totalSize: number;
  transferred: number;
  status: "active" | "done" | "failed";
  error?: string;
  autoAccepted: boolean;
  saved: { name: string; path: string }[];
  /** Smoothed bytes per second while active. */
  speedBps: number;
  startedAt: number;
  sample: { at: number; bytes: number };
};

/** Higher = steadier speed readout, slower to react. */
const SPEED_SMOOTHING_MS = 2000;

/** Folds LAN transfer events into the list shown in the UI (newest first). */
export function applyTransferEvent(list: NativeTransfer[], event: LanEvent, now = Date.now()): NativeTransfer[] {
  const update = (id: string, change: (t: NativeTransfer) => NativeTransfer) =>
    list.map((t) => (t.id === id ? change(t) : t));

  switch (event.type) {
    case "transferStarted":
      return [
        {
          id: event.transferId,
          direction: event.direction,
          peerAlias: event.peer.alias,
          files: event.files,
          totalSize: event.totalSize,
          transferred: 0,
          status: "active",
          autoAccepted: event.autoAccepted,
          saved: [],
          speedBps: 0,
          startedAt: now,
          sample: { at: now, bytes: 0 },
        },
        ...list.filter((t) => t.id !== event.transferId),
      ];
    case "transferProgress":
      return update(event.transferId, (t) => {
        const transferred = Math.max(t.transferred, event.transferred);
        const elapsed = now - t.sample.at;
        if (elapsed < 200) return { ...t, transferred };
        const instant = ((transferred - t.sample.bytes) * 1000) / elapsed;
        const weight = t.speedBps === 0 ? 1 : 1 - Math.exp(-elapsed / SPEED_SMOOTHING_MS);
        return { ...t, transferred, speedBps: t.speedBps + (instant - t.speedBps) * weight, sample: { at: now, bytes: transferred } };
      });
    case "fileReceived":
      return update(event.transferId, (t) => ({ ...t, saved: [...t.saved, { name: event.name, path: event.path }] }));
    case "transferFinished":
      return update(event.transferId, (t) => ({
        ...t,
        status: event.ok ? "done" : "failed",
        transferred: event.ok ? t.totalSize : t.transferred,
        // Average over the whole transfer once it's over.
        speedBps: event.ok && now > t.startedAt ? (t.totalSize * 1000) / (now - t.startedAt) : 0,
        error: event.error ?? undefined,
      }));
    default:
      return list;
  }
}
