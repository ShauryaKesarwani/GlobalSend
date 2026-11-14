export const CONNECT_TO_PARAM = "connectTo";
export const CONNECT_ALIAS_PARAM = "alias";
/** Single-use token from an NFC tap; lets the receiver's app auto-accept. */
export const NFC_TOKEN_PARAM = "nfcToken";

type BuildPeerConnectUrlOptions = {
  origin: string;
  path?: string;
  peerId: string;
  alias?: string;
};

/**
 * Builds a browser-safe link that opens the app and asks it to connect to a
 * specific peer after WebSocket presence has loaded.
 */
export function buildPeerConnectUrl({
  origin,
  path = "/test",
  peerId,
  alias,
}: BuildPeerConnectUrlOptions) {
  const url = new URL(path, origin);
  url.searchParams.set(CONNECT_TO_PARAM, peerId);

  if (alias) {
    url.searchParams.set(CONNECT_ALIAS_PARAM, alias);
  }

  return url.toString();
}

export function getConnectPeerId(searchParams: URLSearchParams) {
  const peerId = searchParams.get(CONNECT_TO_PARAM)?.trim();
  return peerId || null;
}

export function getConnectPeerAlias(searchParams: URLSearchParams) {
  const alias = searchParams.get(CONNECT_ALIAS_PARAM)?.trim();
  return alias || null;
}

export function getConnectNfcToken(searchParams: URLSearchParams) {
  const token = searchParams.get(NFC_TOKEN_PARAM)?.trim();
  return token || null;
}

export type ConnectLink = { peerId: string; alias: string | null; nfcToken: string | null };

/** Reads a connect link (QR code or NFC tag); null if it isn't one. */
export function parseConnectLink(link: string): ConnectLink | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const peerId = getConnectPeerId(url.searchParams);
  if (!peerId) return null;
  return { peerId, alias: getConnectPeerAlias(url.searchParams), nfcToken: getConnectNfcToken(url.searchParams) };
}
