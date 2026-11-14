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
};

/** Folds LAN transfer events into the list shown in the UI (newest first). */
export function applyTransferEvent(list: NativeTransfer[], event: LanEvent): NativeTransfer[] {
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
        },
        ...list.filter((t) => t.id !== event.transferId),
      ];
    case "transferProgress":
      return update(event.transferId, (t) => ({ ...t, transferred: Math.max(t.transferred, event.transferred) }));
    case "fileReceived":
      return update(event.transferId, (t) => ({ ...t, saved: [...t.saved, { name: event.name, path: event.path }] }));
    case "transferFinished":
      return update(event.transferId, (t) => ({
        ...t,
        status: event.ok ? "done" : "failed",
        transferred: event.ok ? t.totalSize : t.transferred,
        error: event.error ?? undefined,
      }));
    default:
      return list;
  }
}
