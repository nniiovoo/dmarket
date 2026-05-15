"use client";

// "Contact seller" CTA. Lives on the product detail page (and could go on
// a seller profile page later). One click flow:
//   1. Make sure the user has a SIWE session (sign in if not).
//   2. POST /api/conversations { chainId, otherParty: sellerAddress, productId }.
//      Server is idempotent: it returns the existing conversation if one
//      already exists between this pair on this chain.
//   3. Push the user into /messages?id=<conversation id>.
//
// The product context (id) is recorded on the conversation when it's
// freshly created so the messenger header can show "started from
// product #X" later.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";

import { startConversation } from "@/lib/api/messages";
import { useSiweAuth } from "@/lib/useSiweAuth";

export function ContactSellerButton({
  sellerAddress,
  chainId,
  productId
}: {
  sellerAddress: string;
  chainId: number;
  productId: string;
}) {
  const router = useRouter();
  const { address } = useAccount();
  const siwe = useSiweAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const sameAsSeller =
    address !== undefined && address.toLowerCase() === sellerAddress.toLowerCase();

  if (sameAsSeller) {
    // Sellers don't message themselves. Hide rather than disable so the
    // "Buy" column stays uncluttered when viewing their own listing.
    return null;
  }

  async function go() {
    setError(undefined);
    setBusy(true);
    try {
      if (!address) {
        setError("Connect your wallet first.");
        return;
      }
      // Ensure SIWE before hitting the auth-gated POST. If the user has a
      // valid session the signIn() call short-circuits via matchesConnected.
      if (!siwe.matchesConnected) {
        const result = await siwe.signIn();
        if (!result.ok) {
          setError(`Sign-in failed: ${result.error}`);
          return;
        }
      }
      const { id } = await startConversation({
        chainId,
        otherParty: sellerAddress,
        productId
      });
      router.push(`/messages?id=${encodeURIComponent(id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start conversation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {busy ? "Opening conversation…" : "💬 Contact seller"}
      </button>
      {error ? <p className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
