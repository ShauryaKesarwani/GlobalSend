"use client";

// Native-app settings: round button at the top right that opens a sheet.
import { useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { native, type AppSettings, type BackgroundMode } from "@/lib/native";

const BACKGROUND_MODES: { value: BackgroundMode; label: string; detail: string }[] = [
  { value: "off", label: "Off", detail: "Only while the app is open. Transfers already running still finish. No battery cost." },
  {
    value: "reachable",
    label: "Reachable (recommended)",
    detail: "Nearby devices can send while the app is closed; you get a notification to accept. Small ongoing notification, low battery use. Replies can take a moment while the phone dozes.",
  },
  {
    value: "alwaysAwake",
    label: "Always awake",
    detail: "Like Reachable, but keeps the CPU and Wi-Fi fully awake so it answers instantly. Noticeably more battery.",
  },
];

function errorText(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong";
}

export function NativeSettings() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const show = async () => {
    setOpen(true);
    try {
      setSettings(await native.settings());
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const update = async (change: Partial<AppSettings>, apply: () => Promise<unknown>) => {
    const previous = settings;
    setSettings((s) => (s ? { ...s, ...change } : s));
    try {
      await apply();
    } catch (error) {
      setSettings(previous);
      toast.error(errorText(error));
    }
  };

  const setAutoAccept = (nfc: boolean, lan: boolean) =>
    update({ nfcAutoAccept: nfc, lanAutoAccept: lan }, () => native.setAutoAccept(nfc, lan));

  const changeFolder = async (reset: boolean) => {
    try {
      const path = reset ? null : await native.pickFolder();
      if (!reset && !path) return;
      const dir = await native.setDownloadDir(path);
      setSettings((s) => (s ? { ...s, downloadDir: dir } : s));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <>
      <button
        onClick={() => void show()}
        aria-label="Settings"
        title="Settings"
        className="fixed right-4 top-4 z-50 flex size-11 items-center justify-center rounded-full border border-stone-300 bg-white/90 text-stone-700 shadow-md backdrop-blur hover:bg-white"
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex justify-end bg-stone-950/40" onClick={() => setOpen(false)}>
            <div
              role="dialog"
              aria-label="Settings"
              onClick={(event) => event.stopPropagation()}
              className="h-full w-full max-w-md overflow-y-auto bg-[#faf9f6] p-5 text-stone-900 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold">Settings</h2>
                <button onClick={() => setOpen(false)} className="rounded-full border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100">Close</button>
              </div>

              {!settings ? (
                <p className="mt-6 text-sm text-stone-500">Loading…</p>
              ) : (
                <div className="mt-5 space-y-6 text-sm">
                  {settings.platform === "android" && (
                    <section>
                      <h3 className="font-semibold">Run in background</h3>
                      <div className="mt-2 space-y-2">
                        {BACKGROUND_MODES.map((mode) => (
                          <label key={mode.value} className="flex items-start gap-3 rounded-2xl border border-stone-200 bg-white p-3">
                            <input
                              type="radio"
                              name="background-mode"
                              className="mt-0.5"
                              checked={settings.backgroundMode === mode.value}
                              onChange={() => void update({ backgroundMode: mode.value }, () => native.setBackgroundMode(mode.value))}
                            />
                            <span>
                              <span className="font-medium">{mode.label}</span>
                              <span className="block text-xs text-stone-500">{mode.detail}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </section>
                  )}

                  <section>
                    <h3 className="font-semibold">Accept without asking</h3>
                    <label className="mt-2 flex items-start gap-3 rounded-2xl border border-stone-200 bg-white p-3">
                      <input type="checkbox" className="mt-0.5" checked={settings.nfcAutoAccept} onChange={(e) => void setAutoAccept(e.target.checked, settings.lanAutoAccept)} />
                      <span>
                        <span className="font-medium">After an NFC tap</span>
                        <span className="block text-xs text-stone-500">Tapping phones together counts as saying yes.</span>
                      </span>
                    </label>
                    <label className="mt-2 flex items-start gap-3 rounded-2xl border border-stone-200 bg-white p-3">
                      <input type="checkbox" className="mt-0.5" checked={settings.lanAutoAccept} onChange={(e) => void setAutoAccept(settings.nfcAutoAccept, e.target.checked)} />
                      <span>
                        <span className="font-medium">From any device on my local network</span>
                        <span className="block text-xs text-stone-500">Anyone on the same Wi-Fi can send you files without asking. Only for networks you trust.</span>
                      </span>
                    </label>
                    <div className="mt-2 rounded-2xl border border-dashed border-stone-300 p-3 text-xs text-stone-500">
                      Coming soon: favourite devices that are always accepted.
                    </div>
                  </section>

                  <section>
                    <h3 className="font-semibold">Download location</h3>
                    <div className="mt-2 rounded-2xl border border-stone-200 bg-white p-3">
                      <div className="break-all text-xs text-stone-700">{settings.downloadDir}</div>
                      {settings.canChangeDownloadDir ? (
                        <div className="mt-2 flex gap-2">
                          <button onClick={() => void changeFolder(false)} className="rounded-full bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700">Change</button>
                          <button onClick={() => void changeFolder(true)} className="rounded-full border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-100">Default</button>
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-stone-500">Received files appear in Files and Photos.</p>
                      )}
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
