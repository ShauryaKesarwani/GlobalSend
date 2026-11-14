import { expect, test } from "bun:test";
import type { LanPeer } from "./native";
import { applyTransferEvent } from "./nativeTransfers";

const peer: LanPeer = { id: "p", alias: "Pixel", platform: "android", address: "192.168.1.5", port: 53318 };
const files = [{ id: "0", name: "a.txt", size: 10, mimeType: "text/plain" }];

test("tracks a received transfer from start to finish", () => {
  let list = applyTransferEvent([], { type: "transferStarted", transferId: "t", direction: "receive", peer, files, totalSize: 10, autoAccepted: true });
  list = applyTransferEvent(list, { type: "transferProgress", transferId: "t", direction: "receive", fileId: "0", transferred: 4, totalSize: 10 });
  expect(list[0]).toMatchObject({ transferred: 4, status: "active", autoAccepted: true, peerAlias: "Pixel" });
  list = applyTransferEvent(list, { type: "fileReceived", transferId: "t", fileId: "0", name: "a.txt", path: "/dl/a.txt" });
  list = applyTransferEvent(list, { type: "transferFinished", transferId: "t", direction: "receive", ok: true, error: null });
  expect(list[0]).toMatchObject({ status: "done", transferred: 10, saved: [{ name: "a.txt", path: "/dl/a.txt" }] });
});

test("keeps the error of a failed transfer and ignores unrelated events", () => {
  let list = applyTransferEvent([], { type: "transferStarted", transferId: "t", direction: "send", peer, files, totalSize: 10, autoAccepted: false });
  list = applyTransferEvent(list, { type: "peersChanged", peers: [] });
  list = applyTransferEvent(list, { type: "transferFinished", transferId: "t", direction: "send", ok: false, error: "declined" });
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ status: "failed", error: "declined", transferred: 0 });
});
