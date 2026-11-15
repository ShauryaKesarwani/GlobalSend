import { expect, test } from "bun:test";
import { PUSH_CHUNK_BYTES, pushFiles, toBase64 } from "./native";

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

test("pushes each file in order as base64 chunks, ending each with an empty chunk", async () => {
  const bytes = Uint8Array.from({ length: PUSH_CHUNK_BYTES + 10 }, (_, i) => i % 251);
  const pushed: { file: number; size: number }[] = [];
  const received: number[] = [];
  const ok = await pushFiles([new Blob([bytes]), new Blob(["hi"]), new Blob([])], async (file, data) => {
    const chunk = decode(data);
    pushed.push({ file, size: chunk.length });
    if (file === 0) received.push(...chunk);
  });
  expect(ok).toBe(true);
  expect(pushed).toEqual([
    { file: 0, size: PUSH_CHUNK_BYTES },
    { file: 0, size: 10 },
    { file: 0, size: 0 },
    { file: 1, size: 2 },
    { file: 1, size: 0 },
    { file: 2, size: 0 },
  ]);
  expect(Uint8Array.from(received)).toEqual(bytes);
});

test("reports failure once the engine says the transfer is gone", async () => {
  let calls = 0;
  const ok = await pushFiles([new Blob(["a"]), new Blob(["b"])], async () => {
    calls += 1;
    throw new Error("transfer is no longer active");
  });
  expect(ok).toBe(false);
  expect(calls).toBe(1);
});

test("base64 matches the standard encoding", () => {
  expect(toBase64(new TextEncoder().encode("GlobalSend!"))).toBe(btoa("GlobalSend!"));
});
