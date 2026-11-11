import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function createWorker(indexedDB) {
  const listeners = {};
  const self = {
    location: { origin: "https://example.com" },
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    self, URL, Response, File, indexedDB, crypto,
  });
  return listeners.fetch;
}

describe("share target service worker", () => {
  test("stores files locally and redirects to the transfer page", async () => {
    let saved;
    const indexedDB = {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = {
            transaction() {
              const transaction = {
                objectStore: () => ({ put: (files, id) => { saved = { files, id }; } }),
              };
              queueMicrotask(() => transaction.oncomplete());
              return transaction;
            },
            close() {},
          };
          request.onsuccess();
        });
        return request;
      },
    };
    const fetch = createWorker(indexedDB);
    const file = new File(["hello"], "photo.jpg", { type: "image/jpeg" });
    let response;
    fetch({ request: { url: "https://example.com/share-target", method: "POST", formData: async () => ({ getAll: () => [file] }) }, respondWith: (promise) => { response = promise; } });
    const result = await response;
    expect(result.status).toBe(303);
    expect(new URL(result.headers.get("location")).searchParams.get("shared")).toBe(saved.id);
    expect(saved.files[0]).toBe(file);
  });

  test("redirects to an error when no files are shared", async () => {
    const fetch = createWorker({});
    let response;
    fetch({ request: { url: "https://example.com/share-target", method: "POST", formData: async () => ({ getAll: () => [] }) }, respondWith: (promise) => { response = promise; } });
    expect(new URL((await response).headers.get("location")).searchParams.get("shareError")).toBe("1");
  });

  test("does not intercept other requests", () => {
    const fetch = createWorker({});
    let intercepted = false;
    fetch({ request: { url: "https://example.com/test", method: "GET" }, respondWith: () => { intercepted = true; } });
    expect(intercepted).toBe(false);
  });
});
