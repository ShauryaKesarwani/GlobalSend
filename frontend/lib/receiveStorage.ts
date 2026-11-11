export type ReceiveSink = {
  write(data: Blob): Promise<void>;
  finish(): Promise<File>;
  discard(): Promise<void>;
};

// Each transfer owns a randomly named file; never use a peer-supplied filename as a path.
export async function openReceiveSink(size: number, storage = typeof navigator === "undefined" ? undefined : navigator.storage): Promise<ReceiveSink | null> {
  if (!storage?.getDirectory) return null;
  let directory: FileSystemDirectoryHandle | undefined;
  let name: string | undefined;
  let stream: FileSystemWritableFileStream | undefined;
  try {
    if (storage.estimate) {
      const { quota, usage } = await storage.estimate();
      if (quota !== undefined && usage !== undefined && size > quota - usage) return null;
    }
    const root = await storage.getDirectory();
    directory = await root.getDirectoryHandle("globalsend-received", { create: true });
    name = crypto.randomUUID();
    const handle = await directory.getFileHandle(name, { create: true });
    stream = await handle.createWritable();
    const targetDirectory = directory;
    const targetName = name;
    const targetStream = stream;
    let closed = false;
    return {
      async write(data) { await targetStream.write(data); },
      async finish() {
        await targetStream.close();
        closed = true;
        return handle.getFile();
      },
      async discard() {
        if (!closed) {
          try { await targetStream.abort(); } catch { /* The stream may already have failed. */ }
        }
        try { await targetDirectory.removeEntry(targetName); } catch { /* Already removed. */ }
      },
    };
  } catch {
    if (stream) { try { await stream.abort(); } catch { /* Best-effort cleanup. */ } }
    if (directory && name) { try { await directory.removeEntry(name); } catch { /* Best-effort cleanup. */ } }
    return null;
  }
}
