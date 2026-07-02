import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#f8f1df,transparent_45%),linear-gradient(180deg,#f6f3ea_0%,#ebe4d4_100%)] px-6 py-16 text-stone-900">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 rounded-[2rem] border border-stone-300/70 bg-white/70 p-8 shadow-[0_24px_80px_rgba(71,51,24,0.12)] backdrop-blur">
        <div className="space-y-4">
          <p className="text-sm uppercase tracking-[0.3em] text-stone-500">Rift</p>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">
            Browser-to-browser transfer testing lives here now.
          </h1>
          <p className="max-w-2xl text-base leading-7 text-stone-700 sm:text-lg">
            Use the dedicated test surface to open two tabs, connect peers, and send real files over WebRTC without pushing file bytes through the backend.
          </p>
        </div>

        <div className="flex flex-wrap gap-4">
          <Link
            href="/test"
            className="rounded-full bg-stone-900 px-5 py-3 text-sm font-medium text-stone-50 transition hover:bg-stone-700"
          >
            Open Transfer Test Lab
          </Link>
          <p className="self-center text-sm text-stone-600">
            Keep the Bun backend running on port 3001, then open a second browser tab or device.
          </p>
        </div>
      </div>
    </main>
  );
}
