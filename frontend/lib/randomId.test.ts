import { expect, test } from "bun:test";
import { randomId } from "./randomId";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("makes UUIDs even where crypto.randomUUID is missing (plain-http LAN pages)", () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const a = randomId();
    expect(a).toMatch(UUID_V4);
    expect(randomId()).not.toBe(a);
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
  }
});
