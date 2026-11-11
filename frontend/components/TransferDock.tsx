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

const button = "inline-flex min-h-8 shrink-0 items-center justify-center rounded-md border border-stone-500 px-2.5 py-1 text-xs font-medium text-stone-100 transition hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

export function TransferDock({ selectedFiles, receivedFiles, onSelect, onSend, sending, target, error }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-7xl flex-col overflow-hidden rounded-2xl border border-stone-500 bg-stone-950 text-stone-100 shadow-2xl sm:inset-x-4 lg:flex-row" aria-label="File transfer controls">
      <section aria-label="Send files" className="order-1 min-w-0 bg-stone-900 px-3 py-2 lg:order-2 lg:flex lg:flex-1 lg:items-center lg:gap-3 lg:border-l lg:border-stone-600">
        <div className="flex items-center gap-2 lg:order-3 lg:flex-col lg:items-stretch lg:gap-1">
          <h2 className="mr-auto whitespace-nowrap text-xs font-semibold lg:mx-auto">Select files</h2>
          <label className={`${button} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-white`}>
            Photos / videos
            <input aria-label="Select photos or videos" className="sr-only" type="file" accept="image/*,video/*" multiple onChange={(event) => { if (event.target.files?.length) onSelect(Array.from(event.target.files)); event.target.value = ""; }} />
          </label>
          <label className={`${button} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-white`}>
            Any files
            <input aria-label="Select any files" className="sr-only" type="file" multiple onChange={(event) => { if (event.target.files?.length) onSelect(Array.from(event.target.files)); event.target.value = ""; }} />
          </label>
        </div>
        <div className="mt-1 flex min-w-0 flex-1 items-center gap-2 lg:mt-0 lg:gap-3">
          <div className="min-w-0 flex-1 lg:order-2">
            <ul aria-label="Selected files" className="max-h-14 overflow-y-auto text-xs leading-6 text-stone-200" title={target ? `Target: ${target}` : "No peer selected"}>
              {selectedFiles.length ? selectedFiles.map((file, index) => <li className="truncate" key={`${file.name}-${file.size}-${index}`} title={file.name}>{file.name}</li>) : <li className="text-stone-400">No files selected</li>}
            </ul>
          </div>
          <button onClick={onSend} disabled={sending || selectedFiles.length === 0} className={`${button} lg:order-1 disabled:cursor-not-allowed disabled:opacity-40`}>{sending ? "Sending…" : "Send files"}</button>
        </div>
        {error && <p role="alert" className="mt-1 max-h-10 overflow-y-auto text-xs text-red-300 lg:max-w-32">{error}</p>}
      </section>

      <section aria-label="Received files" className="order-2 flex min-w-0 items-center gap-2 border-t border-stone-500 bg-stone-950 px-3 py-2 lg:order-1 lg:flex-1 lg:border-t-0">
        {receivedFiles.length > 1 && (
          <button className="flex size-8 shrink-0 items-center justify-center rounded-full border border-stone-500 text-lg leading-none hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" aria-label={expanded ? "Collapse received files" : "Expand received files"} aria-expanded={expanded} aria-controls="received-file-list" onClick={() => setExpanded(!expanded)}>
            <span aria-hidden="true">{expanded ? "⌄" : "⌃"}</span>
          </button>
        )}
        {receivedFiles.length === 0 ? <p className="min-w-0 flex-1 py-1 text-xs text-stone-400">No received files yet</p> : (
          <ul id="received-file-list" aria-label="Received file list" className={`min-w-0 flex-1 overflow-y-auto ${expanded ? "max-h-[min(40vh,24rem)]" : "max-h-32"}`}>
            {receivedFiles.map((file) => (
              <li key={file.id} className="flex h-8 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-stone-200" title={file.name}>{file.name}</span>
                <a href={file.objectUrl} download={downloadName(file.name)} className="shrink-0 rounded border border-stone-600 px-2 py-1 text-[11px] text-stone-100 hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" aria-label={`Download ${file.name}`}>Download</a>
              </li>
            ))}
          </ul>
        )}
        {receivedFiles.length > 1 && <button className={button} onClick={() => downloadAll(receivedFiles)}>Download all</button>}
      </section>
    </div>
  );
}
