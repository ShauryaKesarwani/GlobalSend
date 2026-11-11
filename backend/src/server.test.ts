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
    } finally {
      socket.close();
    }
  } finally {
    server.kill();
    await server.exited;
  }
});
