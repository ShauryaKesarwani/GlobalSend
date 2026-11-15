// One file type for every way a file can be selected:
// - browser `File` (website picker, drag-and-drop, share target)
// - `NativeFile` in the app: a reference to a real path / Android content:// URI.
//   LAN sends read it from disk in Rust (full speed, nothing through the page);
//   WebRTC sends read byte ranges from the app's loopback endpoint on demand.

/** What the senders need from a file. A browser `File` already fits. */
export type SendableFile = {
  name: string;
  size: number;
  type: string;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

export type NativeFileInfo = { path: string; name: string; size: number; mimeType: string; url: string };

/** Bytes fetched per loopback request; sender chunks (≤64 KB) are cut from these. */
export const NATIVE_BLOCK_BYTES = 4 * 1024 * 1024;
const CACHED_BLOCKS = 6;

export class NativeFile implements SendableFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly path: string;
  private readonly url: string;
  private readonly blocks = new Map<number, Promise<Uint8Array>>();

  constructor(info: NativeFileInfo, private readonly fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url)) {
    this.name = info.name;
    this.size = info.size;
    this.type = info.mimeType;
    this.path = info.path;
    this.url = info.url;
  }

  slice(start = 0, end = this.size) {
    return { arrayBuffer: () => this.read(Math.max(0, start), Math.min(end, this.size)) };
  }

  private async read(start: number, end: number): Promise<ArrayBuffer> {
    const out = new Uint8Array(Math.max(0, end - start));
    for (let pos = start; pos < end; ) {
      const index = Math.floor(pos / NATIVE_BLOCK_BYTES);
      const block = await this.block(index);
      const from = pos - index * NATIVE_BLOCK_BYTES;
      const take = Math.min(end - pos, block.length - from);
      if (take <= 0) throw new Error(`${this.name} is shorter than expected`);
      out.set(block.subarray(from, from + take), pos - start);
      pos += take;
    }
    return out.buffer;
  }

  private block(index: number) {
    let block = this.blocks.get(index);
    if (!block) {
      const start = index * NATIVE_BLOCK_BYTES;
      const end = Math.min(this.size, start + NATIVE_BLOCK_BYTES);
      block = this.fetchImpl(`${this.url}&start=${start}&end=${end}`).then(async (response) => {
        if (!response.ok) throw new Error(`Could not read ${this.name} (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      });
      block.catch(() => this.blocks.delete(index));
      this.blocks.set(index, block);
      // Senders read roughly in order, so drop the oldest blocks.
      while (this.blocks.size > CACHED_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
    }
    return block;
  }
}

export function isNativeFile(file: SendableFile): file is NativeFile {
  return file instanceof NativeFile;
}
