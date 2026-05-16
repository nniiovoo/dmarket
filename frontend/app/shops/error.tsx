"use client";

import Link from "next/link";

export default function ShopsError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold text-slate-950">Couldn&apos;t load shops</h1>
      <p className="mt-3 text-sm text-slate-600">{error.message || "Unknown error."}</p>
      <p className="mt-2 text-xs text-slate-500">
        The indexer may be catching up. See{" "}
        <Link href="/api/indexer/status" className="text-blue-600 underline">
          /api/indexer/status
        </Link>{" "}
        for the v3.3 shop-economy block.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Retry
        </button>
        <Link
          href="/"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Home
        </Link>
      </div>
    </main>
  );
}
