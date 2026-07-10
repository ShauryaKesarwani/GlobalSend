export const CONNECT_TO_PARAM = "connectTo";
export const CONNECT_ALIAS_PARAM = "alias";

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
