"use client";

import { useEffect, useRef, useState } from "react";
import { WSClient } from "@/lib/ws";

type Peer = { id: string; alias: string };
type IncomingInvite = {
  from: string;
  file?: { name: string; size: number; mimeType: string };
};

type TransferProgress = {
  id: string;
  peerId: string;
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  direction: "send" | "receive";
};

type ReceivedFile = {
  id: string;
  from: string;
  name: string;
  mimeType: string;
  size: number;
  objectUrl: string;
};

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const SESSION_ID = `peer-${Math.random().toString(36).slice(2, 7)}`;
const ALIAS = `user-${Math.random().toString(36).slice(2, 5)}`;

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatFileCount(count: number) {
  return `${count} file${count === 1 ? "" : "s"}`;
}

function sanitizeDownloadName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export default function TransferTestPage() {
  const clientRef = useRef<WSClient | null>(null);
  const selectedPeerRef = useRef<string | null>(null);
  const sentFileNamesRef = useRef<Map<string, string>>(new Map());
  const receivedFilesRef = useRef<ReceivedFile[]>([]);

  const [peers, setPeers] = useState<Peer[]>([]);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [invite, setInvite] = useState<IncomingInvite | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState<string>("");
  const [transferProgress, setTransferProgress] = useState<TransferProgress[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);

  const addLog = (msg: string) => setLogs((prev) => [...prev.slice(-79), msg]);

  useEffect(() => {
    receivedFilesRef.current = receivedFiles;
  }, [receivedFiles]);

  useEffect(() => {
    const client = new WSClient(SESSION_ID, ALIAS, {
      onPeerList: (list) => setPeers(list.filter((peer) => peer.id !== SESSION_ID)),
      onPeerJoined: (peer) => {
        if (peer.id === SESSION_ID) return;
        setPeers((prev) => [...prev.filter((item) => item.id !== peer.id), peer]);
      },
      onPeerLeft: (peerId) => {
        setPeers((prev) => prev.filter((peer) => peer.id !== peerId));
        setConnectedPeers((prev) => prev.filter((id) => id !== peerId));
        setTransferProgress((prev) => prev.filter((item) => item.peerId !== peerId));
      },
      onTransferInvite: (from, file) => {
        setInvite({ from, file });
        addLog(
          file
            ? `Invite received from ${from} for ${file.name}`
            : `Connection invite received from ${from}`,
        );
      },
      onTransferAccepted: (from) => {
        setConnectedPeers((prev) => (prev.includes(from) ? prev : [...prev, from]));
      },
      onTransferDeclined: (from) => addLog(`${from} declined the transfer`),
      onDataChannelOpen: (peerId) => {
        setConnectedPeers((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]));
      },
      onDataChannelMessage: (peerId, data) => {
        const preview = typeof data === "string" ? data : `[binary ${data.byteLength} bytes]`;
        setMessages((prev) => [...prev, `${peerId}: ${preview}`]);
      },
      onFileStart: (peerId, file) => {
        setTransferProgress((prev) => [
          ...prev.filter((item) => item.id !== file.id),
          {
            id: file.id,
            peerId,
            fileName: file.name,
            transferredBytes: 0,
            totalBytes: file.size,
            direction: "receive",
          },
        ]);
      },
      onFileProgress: (peerId, progress) => {
        setTransferProgress((prev) => {
          const knownName =
            progress.direction === "send"
              ? sentFileNamesRef.current.get(peerId) ?? "selected-file"
              : prev.find((item) => item.id === progress.id)?.fileName ?? "incoming-file";

          const next: TransferProgress = {
            id: progress.id,
            peerId,
            fileName: knownName,
            transferredBytes: progress.transferredBytes,
            totalBytes: progress.totalBytes,
            direction: progress.direction,
          };

          return [...prev.filter((item) => item.id !== progress.id), next];
        });
      },
      onFileComplete: (peerId, file) => {
        setReceivedFiles((prev) => [file, ...prev]);
        setTransferProgress((prev) =>
          prev.map((item) =>
            item.id === file.id
              ? { ...item, transferredBytes: item.totalBytes }
              : item,
          ),
        );
        addLog(`Saved ${file.name} from ${peerId} into the downloads list`);
      },
      onLog: addLog,
      onReconnecting: (attempt) => {
        addLog(`WS disconnected — reconnecting (attempt ${attempt})...`);
        // Optional: set a state var to show a banner in the UI
      },
      onReconnected: () => {
        addLog("WS reconnected — presence restored");
      },
    });

    clientRef.current = client;

    return () => {
      client.dispose();
      for (const file of receivedFilesRef.current) {
        URL.revokeObjectURL(file.objectUrl);
      }
    };
  }, []);

  const sendInvite = (peer: Peer) => {
    const oversizedFile = selectedFiles.find((file) => file.size > MAX_FILE_SIZE);
    if (oversizedFile) {
      setError(`${oversizedFile.name} is larger than ${formatBytes(MAX_FILE_SIZE)}.`);
      return;
    }

    setError("");
    selectedPeerRef.current = peer.id;
    setSelectedPeerId(peer.id);
    sentFileNamesRef.current.set(peer.id, selectedFiles.map((file) => file.name).join(", "));
    const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    clientRef.current?.sendTransferInvite(
      peer.id,
      selectedFiles.length > 0
        ? {
            name:
              selectedFiles.length === 1
                ? selectedFiles[0].name
                : `${formatFileCount(selectedFiles.length)} selected`,
            size: totalSize,
            mimeType:
              selectedFiles.length === 1
                ? selectedFiles[0].type || "application/octet-stream"
                : "application/octet-stream",
          }
        : undefined,
    );
  };

  const acceptInvite = () => {
    if (!invite) return;
    selectedPeerRef.current = invite.from;
    setSelectedPeerId(invite.from);
    clientRef.current?.sendTransferAccept(invite.from);
    setInvite(null);
  };

  const declineInvite = () => {
    if (!invite) return;
    clientRef.current?.sendTransferDecline(invite.from);
    setInvite(null);
  };

  const sendSelectedFiles = async () => {
    if (selectedFiles.length === 0 || !selectedPeerId) {
      setError("Pick a peer and wait for the WebRTC connection before sending files.");
      return;
    }

    if (!connectedPeers.includes(selectedPeerId)) {
      setError("The peer is not connected yet. Wait for the green connected status.");
      return;
    }

    const oversizedFile = selectedFiles.find((file) => file.size > MAX_FILE_SIZE);
    if (oversizedFile) {
      setError(`${oversizedFile.name} is larger than ${formatBytes(MAX_FILE_SIZE)}.`);
      return;
    }

    setError("");

    try {
      for (const file of selectedFiles) {
        const progressId = `${selectedPeerId}:${file.name}`;
        sentFileNamesRef.current.set(selectedPeerId, file.name);
        setTransferProgress((prev) => [
          ...prev.filter((item) => item.id !== progressId),
          {
            id: progressId,
            peerId: selectedPeerId,
            fileName: file.name,
            transferredBytes: 0,
            totalBytes: file.size,
            direction: "send",
          },
        ]);

        await clientRef.current?.sendFile(selectedPeerId, file);
        addLog(`File sent to ${selectedPeerId}: ${file.name}`);
      }
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Unknown send error";
      setError(message);
      addLog(`Send failed: ${message}`);
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#f0e3c2,transparent_40%),linear-gradient(180deg,#f6f3eb_0%,#ddd2bb_100%)] px-4 py-8 text-stone-900 sm:px-6">
      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-[2rem] border border-stone-300/80 bg-white/80 p-6 shadow-[0_20px_70px_rgba(58,41,19,0.14)] backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-200 pb-5">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-stone-500">Transfer Test Lab</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Real-file WebRTC test surface</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-700 sm:text-base">
                Connect to a peer first or pick files first. Once the WebRTC connection opens, choose files anytime and send the actual bytes directly. The backend only relays signaling.
              </p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
              <div><strong>Session</strong> {SESSION_ID}</div>
              <div><strong>Alias</strong> {ALIAS}</div>
            </div>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
            <div className="space-y-6">
              <div className="rounded-3xl border border-stone-200 bg-stone-50/70 p-5">
                <label className="block text-sm font-medium text-stone-700">Files for transfer test</label>
                <input
                  type="file"
                  multiple
                  className="mt-3 block w-full rounded-2xl border border-dashed border-stone-300 bg-white px-4 py-6 text-sm text-stone-700 file:mr-4 file:rounded-full file:border-0 file:bg-stone-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-stone-50 hover:file:bg-stone-700"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    setSelectedFiles(files);
                    setError("");
                  }}
                />
                <p className="mt-3 text-xs leading-5 text-stone-500">
                  Safety guardrail: this test route currently limits each file to {formatBytes(MAX_FILE_SIZE)} so the receiver keeps one file in memory at a time.
                </p>
                {selectedFiles.length > 0 && (
                  <div className="mt-4 rounded-2xl bg-white px-4 py-3 text-sm text-stone-700 shadow-sm">
                    <div className="font-medium text-stone-900">
                      {formatFileCount(selectedFiles.length)} selected · {formatBytes(selectedFiles.reduce((sum, file) => sum + file.size, 0))} total
                    </div>
                    <div className="mt-3 space-y-2">
                      {selectedFiles.map((file, index) => (
                        <div key={`${file.name}-${file.size}-${index}`} className="rounded-xl bg-stone-50 px-3 py-2">
                          <div className="font-medium text-stone-800">{file.name}</div>
                          <div>{formatBytes(file.size)} · {file.type || "application/octet-stream"}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {error && (
                  <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                )}
              </div>

              <div className="rounded-3xl border border-stone-200 bg-stone-50/70 p-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold text-stone-900">Online peers</h2>
                  <span className="rounded-full bg-white px-3 py-1 text-xs uppercase tracking-[0.2em] text-stone-500 shadow-sm">
                    {peers.length} visible
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  {peers.length === 0 && (
                    <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-6 text-sm text-stone-600">
                      No other peers yet. Open this route in another tab or device on the same signaling backend.
                    </p>
                  )}
                  {peers.map((peer) => {
                    const isConnected = connectedPeers.includes(peer.id);
                    return (
                      <div key={peer.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-stone-900">{peer.alias}</div>
                            <div className="text-xs text-stone-500">{peer.id}</div>
                          </div>
                          <div className={`rounded-full px-3 py-1 text-xs font-medium ${isConnected ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-600"}`}>
                            {isConnected ? "connected" : "awaiting handshake"}
                          </div>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            onClick={() => sendInvite(peer)}
                            disabled={isConnected}
                            className="rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-stone-50 transition enabled:hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {isConnected ? "Connected" : "Connect"}
                          </button>
                          <button
                            onClick={() => {
                              setSelectedPeerId(peer.id);
                              selectedPeerRef.current = peer.id;
                              setError("");
                            }}
                            className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-100"
                          >
                            Select peer
                          </button>
                          <button
                            onClick={() => clientRef.current?.sendDataChannelMessage(peer.id, "hello over WebRTC")}
                            disabled={!isConnected}
                            className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 transition enabled:hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Ping channel
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="rounded-3xl border border-stone-200 bg-stone-50/70 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-stone-900">Send the actual files</h2>
                    <p className="mt-1 text-sm text-stone-600">Connect to a peer first, then choose files anytime and send them directly.</p>
                  </div>
                  <div className="text-sm text-stone-600">
                    Target: <strong>{selectedPeerId || "none"}</strong>
                  </div>
                </div>
                <button
                  onClick={() => void sendSelectedFiles()}
                  className="mt-4 rounded-full bg-amber-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-amber-500"
                >
                  Send selected files now
                </button>
              </div>

              <div className="rounded-3xl border border-stone-200 bg-stone-50/70 p-5">
                <h2 className="text-lg font-semibold text-stone-900">Transfer progress</h2>
                <div className="mt-4 space-y-3">
                  {transferProgress.length === 0 && (
                    <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-6 text-sm text-stone-600">
                      No transfers yet. Connect to a peer and then send files after the channel opens.
                    </p>
                  )}
                  {transferProgress.map((item) => {
                    const percent = item.totalBytes === 0 ? 0 : Math.min(100, Math.round((item.transferredBytes / item.totalBytes) * 100));
                    return (
                      <div key={item.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="font-medium text-stone-900">{item.fileName}</div>
                            <div className="text-xs uppercase tracking-[0.2em] text-stone-500">
                              {item.direction === "send" ? "sending" : "receiving"} · {item.peerId}
                            </div>
                          </div>
                          <div className="text-sm text-stone-600">{percent}%</div>
                        </div>
                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-200">
                          <div className="h-full rounded-full bg-stone-900 transition-all" style={{ width: `${percent}%` }} />
                        </div>
                        <div className="mt-2 text-xs text-stone-500">
                          {formatBytes(item.transferredBytes)} / {formatBytes(item.totalBytes)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-3xl border border-stone-200 bg-stone-50/70 p-5">
                <h2 className="text-lg font-semibold text-stone-900">Received files</h2>
                <div className="mt-4 space-y-3">
                  {receivedFiles.length === 0 && (
                    <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-6 text-sm text-stone-600">
                      Incoming files will appear here with a safe download link once the transfer completes.
                    </p>
                  )}
                  {receivedFiles.map((file) => (
                    <div key={file.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                      <div className="font-medium text-stone-900">{file.name}</div>
                      <div className="mt-1 text-sm text-stone-600">From {file.from} · {formatBytes(file.size)}</div>
                      <a
                        href={file.objectUrl}
                        download={sanitizeDownloadName(file.name)}
                        className="mt-3 inline-flex rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-stone-50 transition hover:bg-stone-700"
                      >
                        Download file
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className="space-y-6 rounded-[2rem] border border-stone-300/80 bg-stone-950 p-6 text-stone-100 shadow-[0_20px_70px_rgba(33,24,13,0.35)]">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-stone-400">Incoming request</p>
            {!invite ? (
              <p className="mt-3 text-sm leading-6 text-stone-300">No pending invite right now.</p>
            ) : (
              <div className="mt-4 rounded-3xl border border-amber-300/30 bg-amber-100/10 p-4 text-sm text-stone-100">
                <div className="font-medium">
                  {invite.file
                    ? `${invite.from} wants to send ${invite.file.name}.`
                    : `${invite.from} wants to connect.`}
                </div>
                <div className="mt-2 text-stone-300">
                  {invite.file
                    ? `${invite.file.name} · ${formatBytes(invite.file.size)}`
                    : "Accept to open a WebRTC data channel. Files can be selected and sent later."}
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={acceptInvite}
                    className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400"
                  >
                    Accept
                  </button>
                  <button
                    onClick={declineInvite}
                    className="rounded-full border border-stone-500 px-4 py-2 text-sm font-medium text-stone-100 transition hover:bg-stone-800"
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-stone-400">Channel messages</p>
            <div className="mt-4 max-h-56 space-y-2 overflow-y-auto rounded-3xl bg-stone-900 p-4 text-sm text-stone-300">
              {messages.length === 0 ? (
                <p>No manual data-channel messages yet.</p>
              ) : (
                messages.map((message, index) => <div key={`${message}-${index}`}>{message}</div>)
              )}
            </div>
          </div>

          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-stone-400">Event log</p>
            <div className="mt-4 max-h-[28rem] space-y-2 overflow-y-auto rounded-3xl bg-stone-900 p-4 font-mono text-xs text-emerald-300">
              {logs.map((line, index) => (
                <div key={`${line}-${index}`}>{line}</div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}


