import { expect, test } from "bun:test";
import { PeerConnectionGroup } from "./ws";

test("receives consecutive files when data channels deliver at different speeds", async () => {
  const group = new PeerConnectionGroup(() => null as unknown as WebSocket, "peer", 2);
  const receiver = group as any;
  receiver.openFileSink = async () => null;
  const received: { name: string; blob?: Blob }[] = [];
  group.onFileComplete = (file) => received.push(file);
  const meta = (id: string, name: string) => ({ kind: "file-meta", id, name, mimeType: "application/octet-stream", size: 2, chunkSize: 1, chunkCount: 2, shardCount: 2 });
  const chunk = (index: number, value: number) => ({ index, data: new Uint8Array([value]).buffer });

  // Channel 0 advances to the second file before channel 1 finishes the first.
  receiver.handleFileMeta(0, meta("a", "first.jpg"));
  receiver.handleFileChunk(0, chunk(0, 1));
  receiver.handleFileComplete(0, "a");
  receiver.handleFileMeta(0, meta("b", "second.jpg"));
  receiver.handleFileChunk(0, chunk(0, 3));
  receiver.handleFileComplete(0, "b");
  receiver.handleFileMeta(1, meta("a", "first.jpg"));
  receiver.handleFileChunk(1, chunk(1, 2));
  receiver.handleFileComplete(1, "a");
  receiver.handleFileMeta(1, meta("b", "second.jpg"));
  receiver.handleFileChunk(1, chunk(1, 4));
  receiver.handleFileComplete(1, "b");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received.map((file) => file.name)).toEqual(["first.jpg", "second.jpg"]);
  expect([...new Uint8Array(await received[0].blob!.arrayBuffer())]).toEqual([1, 2]);
  expect([...new Uint8Array(await received[1].blob!.arrayBuffer())]).toEqual([3, 4]);
});
