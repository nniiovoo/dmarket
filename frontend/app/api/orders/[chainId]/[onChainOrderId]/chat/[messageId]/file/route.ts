// Auth-gated download endpoint for a chat message's image attachment.
//
// Anyone in authorizeForOrder's allowlist (buyer + seller + admin + Kleros
// juror) can read. The route itself has no version segment, but the chat
// message row does — and we must use it. V3 #N and V3.1 #N can coexist on
// the same chain, so probing "whichever order table answers first" would
// authorize against the wrong order when IDs collide.

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { authorizeForOrder } from "@/lib/auth/authorize";
import { getSession } from "@/lib/auth/siwe";
import { prisma } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ chainId: string; onChainOrderId: string; messageId: string }>;
};

export const GET = withErrorBoundary(async (_request: NextRequest, context: RouteContext) => {
  const { chainId: chainIdRaw, onChainOrderId, messageId } = await context.params;

  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }
  if (!/^[1-9]\d*$/.test(onChainOrderId)) {
    return NextResponse.json({ error: "Invalid order id" }, { status: 400 });
  }
  if (!messageId || messageId.length > 128) {
    return NextResponse.json({ error: "Invalid message id" }, { status: 400 });
  }

  const message = await prisma.orderChatMessage.findUnique({
    where: { id: messageId }
  });

  // Defense in depth: verify the message is actually attached to the order
  // in the URL. A direct lookup by id is enough for correctness, but
  // matching the URL components prevents accidental leaks if someone
  // crafts /api/orders/123/.../chat/<otherOrderMessage>/file.
  if (
    !message ||
    message.chainId !== chainId ||
    message.onChainOrderId !== onChainOrderId
  ) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  if (!message.attachmentKey || !message.attachmentContentType) {
    return NextResponse.json({ error: "Message has no attachment" }, { status: 404 });
  }

  const session = await getSession();
  const viewer = session?.address ?? null;

  // Same auth model as the chat thread itself — buyer/seller/admin/juror
  // can fetch. Use the message's actual marketplace version so V3 and V3.1
  // orders with the same on-chain ID stay isolated.
  const grant = await authorizeForOrder(
    viewer,
    chainId,
    onChainOrderId,
    message.marketplaceVersion === "v3.1" ? "v3.1" : "v3"
  );
  if (!grant.allowed) {
    const status = grant.reason === "no_session" ? 401 : 403;
    return NextResponse.json(
      {
        error: grant.reason,
        message:
          grant.reason === "no_session"
            ? "Sign in with Ethereum first."
            : "Not authorized to view this attachment."
      },
      { status }
    );
  }

  // Pick the storage backend the row was written under, not the current
  // process default. If they differ (e.g. local → r2 migration), bail
  // honestly rather than silently 404'ing.
  const storage = getStorage();
  if (message.attachmentBackend && message.attachmentBackend !== storage.backend) {
    return NextResponse.json(
      {
        error: "storage_backend_mismatch",
        detail: `Stored with ${message.attachmentBackend}, server now uses ${storage.backend}.`
      },
      { status: 410 }
    );
  }

  const buffer = await storage.get(message.attachmentKey);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": message.attachmentContentType,
      "Content-Length": String(message.attachmentSize ?? buffer.length),
      "Content-Disposition": `inline; filename="${escapeFilename(message.attachmentFileName ?? "attachment")}"`,
      "X-Access-Reason": grant.reason,
      "Cache-Control": "private, no-store"
    }
  });
});

function escapeFilename(name: string) {
  return name.replace(/[\r\n"]/g, "_");
}
