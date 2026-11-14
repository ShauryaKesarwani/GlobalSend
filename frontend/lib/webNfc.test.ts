import { expect, test } from "bun:test";
import { connectLinkFromRecords } from "./webNfc";

const urlRecord = (url: string) => ({ recordType: "url", data: new DataView(new TextEncoder().encode(url).buffer) });

test("finds the GlobalSend connect link among tag records", () => {
  const records = [
    { recordType: "text", data: new DataView(new TextEncoder().encode("hello").buffer) },
    urlRecord("https://other.example/page"),
    urlRecord("https://example.com/test?connectTo=peer-1&alias=Pixel&nfcToken=a.1.b"),
  ];
  expect(connectLinkFromRecords(records)).toEqual({ peerId: "peer-1", alias: "Pixel", nfcToken: "a.1.b" });
});

test("ignores tags without a connect link", () => {
  expect(connectLinkFromRecords([urlRecord("https://example.com/")])).toBeNull();
  expect(connectLinkFromRecords([{ recordType: "url" }])).toBeNull();
});
