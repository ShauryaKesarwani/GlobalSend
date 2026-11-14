import { afterEach, expect, test } from "bun:test";
import { clientIp, networkKey } from "./network";

const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  delete process.env.TRUST_PROXY;
  process.env.NODE_ENV = originalEnv;
});

test("same public IPv4 means same network", () => {
  expect(networkKey("203.0.113.7")).toBe(networkKey("::ffff:203.0.113.7"));
  expect(networkKey("203.0.113.7")).not.toBe(networkKey("203.0.113.8"));
});

test("IPv6 groups by /64 prefix", () => {
  expect(networkKey("2001:db8:1:2::10")).toBe(networkKey("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd"));
  expect(networkKey("2001:db8:1:2::10")).not.toBe(networkKey("2001:db8:1:3::10"));
});

test("local development addresses share one network; unknown has none", () => {
  expect(networkKey("127.0.0.1")).toBe("local");
  expect(networkKey("192.168.1.20")).toBe("local");
  expect(networkKey("::1")).toBe("local");
  expect(networkKey(undefined)).toBeNull();
  expect(networkKey("not-an-ip")).toBeNull();
});

test("in production, private addresses (an untrusted proxy) are never nearby", () => {
  process.env.NODE_ENV = "production";
  expect(networkKey("127.0.0.1")).toBeNull();
  expect(networkKey("203.0.113.7")).toBe("v4:203.0.113.7");
});

test("forwarded headers are only trusted when TRUST_PROXY=1", () => {
  const headers = new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" });
  expect(clientIp(headers, "127.0.0.1")).toBe("127.0.0.1");
  process.env.TRUST_PROXY = "1";
  expect(clientIp(headers, "127.0.0.1")).toBe("198.51.100.4");
});
