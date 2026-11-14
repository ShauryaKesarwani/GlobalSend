import { expect, test } from "bun:test";

test("server upgrades WebSockets and supplies client IP to API routes", async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop();
  const server = Bun.spawn(["bun", "src/index.ts"], {
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = server.stdout.getReader();
    const startup = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(startup.value)).toContain("Server running");

    const socket = new WebSocket(`ws://localhost:${port}/ws?id=regression-test`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("WebSocket upgrade failed"));
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
      const response = await fetch(`http://localhost:${port}/api/session`, { method: "POST" });
      expect(response.status).toBe(200);
      expect((await response.json()).token).toBeTruthy();

      // Two clients from the same (local) network see each other as nearby.
      const next = (ws: WebSocket, type: string) =>
        new Promise<any>((resolve) => {
          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(String(event.data));
            if (msg.type === type) resolve(msg);
          });
        });
      socket.send(JSON.stringify({ type: "join", alias: "first" }));
      const second = new WebSocket(`ws://localhost:${port}/ws?id=nearby-test`);
      await new Promise((resolve) => (second.onopen = resolve));
      const joined = next(socket, "peer_joined");
      const list = next(second, "peer_list");
      second.send(JSON.stringify({ type: "join", alias: "second" }));
      expect((await joined).peer).toEqual({ id: "nearby-test", alias: "second", nearby: true });
      expect((await list).peers).toContainEqual({ id: "regression-test", alias: "first", nearby: true });
      second.close();
    } finally {
      socket.close();
    }
  } finally {
    server.kill();
    await server.exited;
  }
});
