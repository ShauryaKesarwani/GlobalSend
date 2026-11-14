import { expect, test } from "bun:test";
import { buildPeerConnectUrl, parseConnectLink } from "./peerDeepLink";

test("parses connect links from QR codes and NFC tags", () => {
  const qr = buildPeerConnectUrl({ origin: "https://example.com", peerId: "peer-ab1", alias: "Desk" });
  expect(parseConnectLink(qr)).toEqual({ peerId: "peer-ab1", alias: "Desk", nfcToken: null });
  expect(parseConnectLink("https://example.com/test?connectTo=peer-ab1&alias=My%20Pixel&nfcToken=n.1.m")).toEqual({
    peerId: "peer-ab1",
    alias: "My Pixel",
    nfcToken: "n.1.m",
  });
});

test("rejects links that aren't connect links", () => {
  expect(parseConnectLink("https://example.com/test")).toBeNull();
  expect(parseConnectLink("javascript:alert(1)?connectTo=x")).toBeNull();
  expect(parseConnectLink("not a url")).toBeNull();
});
