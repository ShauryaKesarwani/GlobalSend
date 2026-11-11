export async function takeSharedFiles(id: string): Promise<File[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("globalsend-shares", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("shares");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<File[]>((resolve, reject) => {
      const transaction = db.transaction("shares", "readwrite");
      const store = transaction.objectStore("shares");
      const request = store.get(id);
      let files: File[] = [];
      request.onsuccess = () => {
        if (Array.isArray(request.result)) {
          files = request.result.filter((item: unknown) => item instanceof File);
        }
        store.delete(id);
      };
      transaction.oncomplete = () => resolve(files);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
