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

const button = "inline-flex min-h-9 shrink-0 items-center justify-center rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-700";

export function TransferDock({ selectedFiles, receivedFiles, onSelect, onSend, sending, target, error }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-3xl border border-b-0 border-stone-200 bg-[#faf9f6] pb-[env(safe-area-inset-bottom)] text-stone-900 shadow-[0_-8px_30px_rgba(58,41,19,0.12)] lg:flex-row" aria-label="File transfer controls">
      <section aria-label="Send files" className="order-1 flex min-w-0 items-center gap-3 px-4 py-3 lg:order-2 lg:flex-1 lg:border-l lg:border-stone-200">
        <button onClick={onSend} disabled={sending || selectedFiles.length === 0} aria-label={sending ? "Sending files" : "Send files"} title={sending ? "Sending files" : "Send files"} className="flex size-16 shrink-0 flex-col items-center justify-center rounded-full bg-stone-900 text-white hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-500">
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          <span className="text-xs font-medium">{sending ? "Sending" : "All"}</span>
        </button>
        <div className="flex min-w-0 flex-col items-start gap-1 sm:shrink-0">
          <h2 className="text-sm font-semibold text-stone-900">Select or drag and drop files</h2>
          <div className="flex flex-wrap gap-1">
            <label className={`${button} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-stone-700`}>
              Photos / videos
              <input aria-label="Select photos or videos" className="sr-only" type="file" accept="image/*,video/*" multiple onChange={(event) => { if (event.target.files?.length) onSelect(Array.from(event.target.files)); event.target.value = ""; }} />
            </label>
            <label className={`${button} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-stone-700`}>
              Any files
              <input aria-label="Select any files" className="sr-only" type="file" multiple onChange={(event) => { if (event.target.files?.length) onSelect(Array.from(event.target.files)); event.target.value = ""; }} />
            </label>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <ul aria-label="Selected files" className="max-h-20 overflow-y-auto text-sm leading-6 text-stone-700" title={target ? `Target: ${target}` : "No peer selected"}>
            {selectedFiles.length ? selectedFiles.map((file, index) => <li className="truncate" key={`${file.name}-${file.size}-${index}`} title={file.name}>{file.name}</li>) : <li className="text-stone-600">No files selected</li>}
          </ul>
          {error && <p role="alert" className="mt-1 max-h-10 overflow-y-auto text-sm text-red-700">{error}</p>}
        </div>
      </section>

      <section aria-label="Received files" className="order-2 flex min-w-0 items-center gap-2 border-t border-stone-200 bg-transparent px-4 py-3 lg:order-1 lg:flex-1 lg:border-t-0">
        {receivedFiles.length > 1 && (
          <button className="flex size-8 shrink-0 items-center justify-center rounded-full border border-stone-300 text-lg leading-none hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-700" aria-label={expanded ? "Collapse received files" : "Expand received files"} aria-expanded={expanded} aria-controls="received-file-list" onClick={() => setExpanded(!expanded)}>
            <span aria-hidden="true">{expanded ? "⌄" : "⌃"}</span>
          </button>
        )}
        {receivedFiles.length === 0 ? <p className="min-w-0 flex-1 py-1 text-sm text-stone-600">No received files yet</p> : (
          <ul id="received-file-list" aria-label="Received file list" className={`min-w-0 flex-1 overflow-y-auto ${expanded ? "max-h-[min(40vh,24rem)]" : "max-h-32"}`}>
            {receivedFiles.map((file) => (
              <li key={file.id} className="flex h-8 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-stone-700" title={file.name}>{file.name}</span>
                <a href={file.objectUrl} download={downloadName(file.name)} className="shrink-0 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-700" aria-label={`Download ${file.name}`}>Download</a>
              </li>
            ))}
          </ul>
        )}
        {receivedFiles.length > 1 && <button aria-label="Download all" title="Download all" className="flex size-16 shrink-0 flex-col items-center justify-center rounded-full bg-stone-900 text-white hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-700" onClick={() => downloadAll(receivedFiles)}><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14m-7-7 7 7 7-7" /></svg><span className="text-xs font-medium">All</span></button>}
      </section>
    </div>
  );
}
