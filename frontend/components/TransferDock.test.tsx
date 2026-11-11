import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { downloadAll, TransferDock } from "./TransferDock";

const file = (id: string) => ({ id, name: `file ${id}.txt`, objectUrl: `blob:${id}` });
const props = { selectedFiles: [], onSelect: () => {}, onSend: () => {}, sending: false, target: "", error: "" };

describe("transfer dock", () => {
  test("offers an individual download for one received file", () => {
    const html = renderToStaticMarkup(<TransferDock {...props} receivedFiles={[file("1")]} />);
    expect(html).toContain('download="file_1.txt"');
    expect(html).not.toContain("Download all");
  });

  test("offers all individual downloads and expand controls for multiple files", () => {
    const html = renderToStaticMarkup(<TransferDock {...props} receivedFiles={[file("1"), file("2")]} />);
    expect(html).toContain("Download all");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Download file 2.txt"');
  });

  test("download all starts a download for each received file", () => {
    const downloads: { href: string; download: string }[] = [];
    const previous = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      body: { appendChild: () => {} },
      createElement: () => ({ href: "", download: "", click() { downloads.push({ href: this.href, download: this.download }); }, remove() {} }),
    } });
    try {
      downloadAll([file("1"), file("2")]);
      expect(downloads).toEqual([{ href: "blob:1", download: "file_1.txt" }, { href: "blob:2", download: "file_2.txt" }]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previous });
    }
  });
});
