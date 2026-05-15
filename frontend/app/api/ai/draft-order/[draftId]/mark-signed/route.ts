// POST /api/ai/draft-order/[draftId]/mark-signed
//
// Called by the /sign/[draftId] page after the buyer's wallet has
// confirmed the createAndPayWithAuth transaction. Purely a record-keeping
// step — the on-chain tx is authoritative. We use it to:
//   - mark the draft as consumed so a refresh of the sign page shows "signed"
//   - record the txHash for support / audit lookups
//
// Idempotent: a second call with the same draftId is a no-op.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  orderId: z.string().regex(/^\d+$/).nullable().optional()
});

interface Ctx {
  params: Promise<{ draftId: string }>;
}

export const POST = withErrorBoundary(async (request: NextRequest, ctx: Ctx) => {
  const { draftId } = await ctx.params;
  if (!draftId) return NextResponse.json({ error: "missing_draft_id" }, { status: 400 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await prisma.draftOrder.findUnique({ where: { id: draftId } });
  if (!existing) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });

  if (existing.signedAt) {
    return NextResponse.json({ ok: true, alreadySigned: true, txHash: existing.txHash });
  }

  await prisma.draftOrder.update({
    where: { id: draftId },
    data: {
      signedAt: new Date(),
      txHash: parsed.data.txHash
    }
  });

  return NextResponse.json({ ok: true });
});
