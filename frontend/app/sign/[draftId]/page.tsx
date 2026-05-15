// /sign/[draftId] — wallet handoff page.
//
// The page is reachable from an AI-issued sign URL or directly from the
// chainus.org chatbox. It loads the unsigned PaymentAuth payload and
// presents a 3-step UX: approve token → sign typed data → submit
// createAndPayWithAuth. The buyer's wallet pays gas (no relayer in MVP).
//
// Server component just hydrates the draft + decides whether it's
// still actionable; the wallet UI lives in the client child.

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Address } from "viem";

import { prisma } from "@/lib/db";
import { SignDraftClient } from "./SignDraftClient";

export const dynamic = "force-dynamic";

type Params = { draftId: string };
type DraftStatus = "active" | "signed" | "expired" | "cancelled";

function classifyDraftStatus(
  cancelledAt: Date | null,
  signedAt: Date | null,
  expiresAt: Date
): DraftStatus {
  if (cancelledAt) return "cancelled";
  if (signedAt) return "signed";
  if (expiresAt.getTime() < Date.now()) return "expired";
  return "active";
}

interface PageProps {
  params: Promise<Params>;
}

export default async function SignDraftPage({ params }: PageProps) {
  const { draftId } = await params;
  const draft = await prisma.draftOrder.findUnique({ where: { id: draftId } });
  if (!draft) notFound();

  const status = classifyDraftStatus(draft.cancelledAt, draft.signedAt, draft.expiresAt);

  // The page is publicly addressable but only useful to the buyer whose
  // address signed the draft. We hint that here; the client also enforces
  // it before letting the user sign.
  const product = await prisma.product.findUnique({ where: { id: Number(draft.productId) } });

  const h = await headers();
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? `https://${h.get("host") ?? "chainus.org"}`;

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Confirm your order</h1>
      <p className="mt-1 text-sm text-gray-600">
        An AI shopping assistant prepared this order for you. Review the details below and sign with your
        wallet. You always pay your own gas — the agent cannot move your funds.
      </p>

      <section className="mt-6 rounded-md border border-gray-200 p-4 text-sm">
        <div className="grid grid-cols-3 gap-y-1.5">
          <div className="text-gray-500">Product</div>
          <div className="col-span-2 font-medium">{draft.productNameSnapshot || product?.name || `#${draft.productId}`}</div>
          <div className="text-gray-500">Seller</div>
          <div className="col-span-2 font-mono text-xs">{draft.seller}</div>
          <div className="text-gray-500">Buyer (you)</div>
          <div className="col-span-2 font-mono text-xs">{draft.buyer}</div>
          <div className="text-gray-500">Amount</div>
          <div className="col-span-2 font-medium">
            {draft.amount} (base units, paymentToken {draft.paymentToken.slice(0, 6)}…)
          </div>
          <div className="text-gray-500">Expires</div>
          <div className="col-span-2">{draft.expiresAt.toISOString()}</div>
        </div>
      </section>

      {status !== "active" ? (
        <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
          {status === "signed" ? (
            <>
              This draft has already been signed.{" "}
              {draft.txHash ? (
                <a
                  className="text-blue-600 underline"
                  href={`https://sepolia.arbiscan.io/tx/${draft.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction
                </a>
              ) : null}
            </>
          ) : status === "expired" ? (
            "This draft has expired. Ask your assistant to prepare a fresh one."
          ) : (
            "This draft was cancelled."
          )}
        </div>
      ) : (
        <SignDraftClient
          draftId={draft.id}
          buyer={draft.buyer as Address}
          seller={draft.seller as Address}
          paymentToken={draft.paymentToken as Address}
          productId={draft.productId}
          amount={draft.amount}
          nonce={draft.nonce}
          deadlineUnixSec={Math.floor(draft.deadline.getTime() / 1000).toString()}
          chainId={draft.chainId}
          marketplaceAddress={draft.marketplaceAddress as Address}
          origin={origin}
        />
      )}
    </main>
  );
}
