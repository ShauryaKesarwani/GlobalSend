import { describe, expect, test } from "bun:test";
import { messageUrl } from "./messageUrl";

describe("messageUrl", () => {
  test("accepts HTTP and HTTPS links with surrounding whitespace", () => {
    expect(messageUrl(" https://example.com/path ")).toBe("https://example.com/path");
    expect(messageUrl("http://example.com")).toBe("http://example.com/");
  });

  test("does not treat ordinary text or malformed links as URLs", () => {
    expect(messageUrl("hello there")).toBeNull();
    expect(messageUrl("javascript:alert(1)")).toBeNull();
    expect(messageUrl("https://")).toBeNull();
  });
});
