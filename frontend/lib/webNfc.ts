// Web NFC (Chrome on Android only): read the connect link that a phone running
// the GlobalSend app exposes as an NFC tag. Browsers can only read tags, not act
// as one, so a browser can tap to send to an app user but not be tapped.
import { parseConnectLink, type ConnectLink } from "./peerDeepLink";

type NdefRecord = { recordType: string; data?: DataView };
type NdefReadingEvent = Event & { message: { records: NdefRecord[] } };
type NdefReader = EventTarget & { scan(options?: { signal?: AbortSignal }): Promise<void> };

export function isWebNfcSupported(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window && window.isSecureContext;
}

/** First GlobalSend connect link among the records of one tag read, if any. */
export function connectLinkFromRecords(records: NdefRecord[]): ConnectLink | null {
  for (const record of records) {
    if ((record.recordType !== "url" && record.recordType !== "absolute-url") || !record.data) continue;
    const link = parseConnectLink(new TextDecoder().decode(record.data));
    if (link) return link;
  }
  return null;
}

/**
 * Starts scanning (asks for NFC permission on first use) and resolves with the
 * first connect link read. Other tags are ignored. Abort `signal` to stop.
 */
export async function scanForConnectLink(signal: AbortSignal): Promise<ConnectLink> {
  const Reader = (window as unknown as { NDEFReader: new () => NdefReader }).NDEFReader;
  const reader = new Reader();
  await reader.scan({ signal });
  return new Promise((resolve, reject) => {
    const onReading = (event: Event) => {
      const link = connectLinkFromRecords((event as NdefReadingEvent).message.records);
      if (!link) return;
      cleanup();
      resolve(link);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("cancelled", "AbortError"));
    };
    const cleanup = () => {
      reader.removeEventListener("reading", onReading);
      signal.removeEventListener("abort", onAbort);
    };
    reader.addEventListener("reading", onReading);
    signal.addEventListener("abort", onAbort);
  });
}
