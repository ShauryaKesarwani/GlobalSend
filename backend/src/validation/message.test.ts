import { expect, test } from "bun:test";
import { messageSchema } from "./message";

test("transfer-invite keeps an optional NFC tap token", () => {
  const parsed = messageSchema.parse({ type: "transfer-invite", to: "peer-a", nfcToken: "abc.123.def" });
  expect(parsed).toMatchObject({ type: "transfer-invite", nfcToken: "abc.123.def" });
  expect(messageSchema.parse({ type: "transfer-invite", to: "peer-a" })).not.toHaveProperty("nfcToken");
});

test("transfer-invite rejects oversized NFC tokens", () => {
  expect(messageSchema.safeParse({ type: "transfer-invite", to: "peer-a", nfcToken: "x".repeat(257) }).success).toBe(false);
});
