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

test("shows a smoothed speed while active and the average when done", () => {
  let list = applyTransferEvent([], { type: "transferStarted", transferId: "t", direction: "send", peer, files, totalSize: 10_000_000, autoAccepted: false }, 0);
  list = applyTransferEvent(list, { type: "transferProgress", transferId: "t", direction: "send", fileId: "0", transferred: 1_000_000, totalSize: 10_000_000 }, 1000);
  expect(list[0].speedBps).toBe(1_000_000);
  // Updates closer than 200 ms only move the byte count.
  list = applyTransferEvent(list, { type: "transferProgress", transferId: "t", direction: "send", fileId: "0", transferred: 1_100_000, totalSize: 10_000_000 }, 1100);
  expect(list[0]).toMatchObject({ speedBps: 1_000_000, transferred: 1_100_000 });
  list = applyTransferEvent(list, { type: "transferFinished", transferId: "t", direction: "send", ok: true, error: null }, 5000);
  expect(list[0].speedBps).toBe(2_000_000);
});

test("keeps the error of a failed transfer and ignores unrelated events", () => {
  let list = applyTransferEvent([], { type: "transferStarted", transferId: "t", direction: "send", peer, files, totalSize: 10, autoAccepted: false });
  list = applyTransferEvent(list, { type: "peersChanged", peers: [] });
  list = applyTransferEvent(list, { type: "transferFinished", transferId: "t", direction: "send", ok: false, error: "declined" });
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ status: "failed", error: "declined", transferred: 0 });
});
