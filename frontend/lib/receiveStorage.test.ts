import { expect, test } from "bun:test";
import { PeerConnectionGroup } from "./ws";
import { openReceiveSink, type ReceiveSink } from "./receiveStorage";

type Receiver = {
  openFileSink: () => Promise<ReceiveSink | null>;
  handleFileMeta: (shard: number, meta: object) => void;
  handleFileChunk: (shard: number, chunk: object) => void;
  handleFileComplete: (shard: number, id: string) => void;
};

function setup(sink: ReceiveSink | null) {
  const group = new PeerConnectionGroup(() => null as unknown as WebSocket, "peer", 1);
  const receiver = group as unknown as Receiver;
  receiver.openFileSink = async () => sink;
  const start = () => receiver.handleFileMeta(0, { kind: "file-meta", id: "a", name: "file.txt", mimeType: "text/plain", size: 2, chunkSize: 1, chunkCount: 2, shardCount: 1 });
  const chunk = (index: number) => receiver.handleFileChunk(0, { index, data: new Uint8Array([index + 1]).buffer });
  return { group, receiver, start, chunk };
}

test("OPFS sink writes, closes and removes its own temporary file", async () => {
  const written: number[] = [];
  let removed = "";
  const storage = {
    estimate: async () => ({ quota: 100, usage: 0 }),
    getDirectory: async () => ({
      getDirectoryHandle: async () => ({
        getFileHandle: async () => ({
          createWritable: async () => ({ write: async (data: Blob) => { written.push(...new Uint8Array(await data.arrayBuffer())); }, close: async () => {}, abort: async () => {} }),
          getFile: async () => new File([new Uint8Array(written)], "cache"),
        }),
        removeEntry: async (name: string) => { removed = name; },
      }),
    }),
  } as unknown as StorageManager;
  const sink = (await openReceiveSink(2, storage))!;
  await sink.write(new Blob([new Uint8Array([1, 2])]));
  expect([...new Uint8Array(await (await sink.finish()).arrayBuffer())]).toEqual([1, 2]);
  await sink.discard();
  expect(removed).toBeTruthy();
});

test("falls back before writing when estimated storage is insufficient", async () => {
  const storage = { estimate: async () => ({ quota: 10, usage: 9 }), getDirectory: () => { throw new Error("must not open"); } } as unknown as StorageManager;
  expect(await openReceiveSink(2, storage)).toBeNull();
});

test("writes ordered chunks to the disk sink and returns a downloadable file", async () => {
  const writes: number[] = [];
  let discarded = false;
  const sink: ReceiveSink = {
    async write(data) { writes.push(...new Uint8Array(await data.arrayBuffer())); },
    async finish() { return new File([new Uint8Array(writes)], "cache"); },
    async discard() { discarded = true; },
  };
  const { group, receiver, start, chunk } = setup(sink);
  const completed = new Promise<Parameters<NonNullable<typeof group.onFileComplete>>[0]>((resolve) => { group.onFileComplete = resolve; });
  start();
  chunk(1);
  chunk(0);
  receiver.handleFileComplete(0, "a");
  const result = await completed;
  expect(writes).toEqual([1, 2]);
  expect([...new Uint8Array(await result.blob!.arrayBuffer())]).toEqual([1, 2]);
  await result.cleanup?.();
  expect(discarded).toBe(true);
});

test("falls back to memory when disk staging is unavailable", async () => {
  const { group, receiver, start, chunk } = setup(null);
  const completed = new Promise<Parameters<NonNullable<typeof group.onFileComplete>>[0]>((resolve) => { group.onFileComplete = resolve; });
  start(); chunk(0); chunk(1); receiver.handleFileComplete(0, "a");
  expect([...new Uint8Array(await (await completed).blob!.arrayBuffer())]).toEqual([1, 2]);
});

test("batches disk writes without waiting for the transfer to finish", async () => {
  const sizes: number[] = [];
  const sink: ReceiveSink = {
    async write(data) { sizes.push(data.size); },
    async finish() { return new File([], "cache"); },
    async discard() {},
  };
  const { group, receiver } = setup(sink);
  receiver.handleFileMeta(0, { kind: "file-meta", id: "large", name: "large", mimeType: "", size: 4 * 1024 * 1024 + 1, chunkSize: 4 * 1024 * 1024, chunkCount: 2, shardCount: 1 });
  receiver.handleFileChunk(0, { index: 0, data: new ArrayBuffer(4 * 1024 * 1024) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sizes).toEqual([4 * 1024 * 1024]);
  const completed = new Promise<void>((resolve) => { group.onFileComplete = () => resolve(); });
  receiver.handleFileChunk(0, { index: 1, data: new ArrayBuffer(1) });
  receiver.handleFileComplete(0, "large");
  await completed;
  expect(sizes).toEqual([4 * 1024 * 1024, 1]);
});

test("reports a disk write failure instead of offering a partial download", async () => {
  let discarded = false;
  const sink: ReceiveSink = {
    async write() { throw new Error("quota exceeded"); },
    async finish() { throw new Error("must not finish"); },
    async discard() { discarded = true; },
  };
  const { group, receiver, start, chunk } = setup(sink);
  let completed = false;
  group.onFileComplete = () => { completed = true; };
  const failed = new Promise<string>((resolve) => { group.onFileError = resolve; });
  start(); chunk(0); chunk(1); receiver.handleFileComplete(0, "a");
  expect(await failed).toBe("file.txt");
  await Promise.resolve();
  expect(discarded).toBe(true);
  expect(completed).toBe(false);
});
