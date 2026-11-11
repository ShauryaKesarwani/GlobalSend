"use client";

import { useState } from "react";

export type DockReceivedFile = { id: string; name: string; objectUrl: string };

export function downloadName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function downloadAll(files: DockReceivedFile[]) {
  for (const file of files) {
    const link = document.createElement("a");
    link.href = file.objectUrl;
    link.download = downloadName(file.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

type Props = {
  selectedFiles: File[];
  receivedFiles: DockReceivedFile[];
  onSelect: (files: File[]) => void;
  onSend: () => void;
  sending: boolean;
  target: string;
  error: string;
};

const button = "shrink-0 rounded-full border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-700";

export function TransferDock({ selectedFiles, receivedFiles, onSelect, onSend, sending, target, error }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="fixed inset-x-2 bottom-2 z-40 mx-auto flex max-w-7xl flex-col gap-2 sm:inset-x-4 lg:flex-row lg:items-end" aria-label="File transfer controls">
      <section aria-label="Send files" className="min-w-0 rounded-2xl border border-stone-300 bg-stone-50 p-3 shadow-xl lg:flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold">Send files</h2>
          <label className={`${button} cursor-pointer`}>
            Photos / videos
            <input className="sr-only" type="file" accept="image/*,video/*" multiple onChange={(event) => { if (event.target.files?.length) onSelect(Array.from(event.target.files)); event.target.value = ""; }} />
          </label>
          <label className={`${button} cursor-pointer`}>
            Any files
            <input className="sr-only" type="file" multiple onChange={(event) => { if (event.target.files?.length) onSelect(Array.from(event.target.files)); event.target.value = ""; }} />
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <ul aria-label="Selected files" className="max-h-20 overflow-y-auto text-sm text-stone-700">
              {selectedFiles.length ? selectedFiles.map((file, index) => <li className="truncate" key={`${file.name}-${file.size}-${index}`} title={file.name}>{file.name}</li>) : <li>No files selected</li>}
            </ul>
            <p className="truncate text-xs text-stone-500">Target: {target || "none selected"}</p>
          </div>
          <button onClick={onSend} disabled={sending || selectedFiles.length === 0} className="shrink-0 rounded-full bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50">{sending ? "Sending…" : "Send files"}</button>
        </div>
        {error && <p role="alert" className="mt-2 max-h-12 overflow-y-auto text-xs text-red-700">{error}</p>}
      </section>

      <section aria-label="Received files" className="min-w-0 rounded-2xl border border-stone-300 bg-white p-3 shadow-xl lg:flex-1">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold">Received files {receivedFiles.length > 0 && `(${receivedFiles.length})`}</h2>
          {receivedFiles.length > 1 && <button className={button} onClick={() => downloadAll(receivedFiles)}>Download all</button>}
          {receivedFiles.length > 1 && <button className={button} aria-expanded={expanded} aria-controls="received-file-list" onClick={() => setExpanded(!expanded)}>{expanded ? "Collapse" : "Expand"}</button>}
        </div>
        {receivedFiles.length === 0 ? <p className="mt-2 text-sm text-stone-500">Completed files will appear here.</p> : (
          <ul id="received-file-list" className={`mt-2 overflow-y-auto ${expanded ? "max-h-[min(40vh,24rem)]" : "max-h-40"}`}>
            {receivedFiles.map((file) => (
              <li key={file.id} className="flex min-h-10 items-center gap-2 border-t border-stone-100 py-1">
                <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>{file.name}</span>
                <a href={file.objectUrl} download={downloadName(file.name)} className={button} aria-label={`Download ${file.name}`}>Download</a>
              </li>
            ))}
          </ul>
        )}
        {receivedFiles.length > 1 && <p className="mt-1 text-xs text-stone-500">Your browser may ask permission to download multiple files.</p>}
      </section>
    </div>
  );
}
