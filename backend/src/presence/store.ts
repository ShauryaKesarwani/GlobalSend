export const peers = new Map<
  string,
  {
    alias: string;
    lastSeen: number;
    /** Opaque same-network key (see network.ts); never sent to clients. */
    network: string | null;
  }
>();
