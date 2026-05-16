import Link from "next/link";

export default function ShopNotFound() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold text-slate-950">Shop not found</h1>
      <p className="mt-3 text-sm text-slate-600">
        That shop id doesn&apos;t match any indexed ShopNFT. Either it doesn&apos;t exist yet, or the
        indexer is still catching up.
      </p>
      <p className="mt-2 text-xs text-slate-500">
        Check{" "}
        <Link href="/api/indexer/status" className="text-blue-600 underline">
          /api/indexer/status
        </Link>{" "}
        for the v3.3 shopNft cursor.
      </p>
      <Link
        href="/shops"
        className="mt-6 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        ← Back to shops
      </Link>
    </main>
  );
}
