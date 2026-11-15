import { expect, test } from "bun:test";
import { NATIVE_BLOCK_BYTES, NativeFile } from "./sendableFile";

function fakeFile(bytes: Uint8Array) {
  const requests: string[] = [];
  const fetchImpl = async (input: string) => {
    requests.push(input);
    const url = new URL(input);
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    return new Response(bytes.slice(start, end));
  };
  const file = new NativeFile(
    { path: "content://x/1", name: "a.bin", size: bytes.length, mimeType: "application/octet-stream", url: "http://127.0.0.1:1/f?token=t" },
    fetchImpl,
  );
  return { file, requests };
}

test("reads any slice, including ones spanning blocks", async () => {
  const bytes = Uint8Array.from({ length: NATIVE_BLOCK_BYTES + 100 }, (_, i) => i % 253);
  const { file } = fakeFile(bytes);
  const from = NATIVE_BLOCK_BYTES - 10;
  const slice = new Uint8Array(await file.slice(from, from + 50).arrayBuffer());
  expect(slice).toEqual(bytes.slice(from, from + 50));
  expect(new Uint8Array(await file.slice(0, 5).arrayBuffer())).toEqual(bytes.slice(0, 5));
});

test("small sender chunks share one loopback request per block", async () => {
  const { file, requests } = fakeFile(new Uint8Array(200_000));
  await Promise.all([0, 1, 2].map((i) => file.slice(i * 64 * 1024, (i + 1) * 64 * 1024).arrayBuffer()));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("&start=0&end=200000");
});
