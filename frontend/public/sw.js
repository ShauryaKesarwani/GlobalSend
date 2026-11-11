self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== "/share-target" || event.request.method !== "POST") return;

  event.respondWith((async () => {
    const destination = new URL("/test", self.location.origin);
    try {
      const form = await event.request.formData();
      const files = form.getAll("files").filter((item) => item instanceof File && item.name);
      if (!files.length) throw new Error("No files shared");
      const id = crypto.randomUUID();
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("globalsend-shares", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("shares");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction("shares", "readwrite");
          transaction.objectStore("shares").put(files, id);
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
      destination.searchParams.set("shared", id);
    } catch {
      destination.searchParams.set("shareError", "1");
    }
    return Response.redirect(destination.href, 303);
  })());
});
