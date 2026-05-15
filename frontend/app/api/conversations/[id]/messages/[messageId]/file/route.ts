// Auth-gated attachment download for a conversation message.
//
// Only the two conversation participants can read. Same auth shape as the
// old per-order chat attachment route — except we don't need to thread
// marketplaceVersion through, because conversations don't belong to a
// marketplace at all.

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { getSession } from "@/lib/auth/siwe";
import { isParticipant } from "@/lib/conversations";
import { prisma } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string; messageId: string }>;
};

export const GET = withErrorBoundary(async (_request: NextRequest, context: RouteContext) => {
  const { id: conversationId, messageId } = await context.params;

  if (!conversationId || conversationId.length > 128) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }
  if (!messageId || messageId.length > 128) {
    return NextResponse.json({ error: "Invalid message id" }, { status: 400 });
  }

  const message = await prisma.conversationMessage.findUnique({ where: { id: messageId } });

  // Defense in depth: confirm the message belongs to the conversation in
  // the URL. Direct lookup by id is correct, but matching the path prevents
  // accidental leaks if someone tries swapping ids.
  if (!message || message.conversationId !== conversationId) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }
  if (!message.attachmentKey || !message.attachmentContentType) {
    return NextResponse.json({ error: "Message has no attachment" }, { status: 404 });
  }

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "no_session", message: "Sign in with Ethereum first." },
      { status: 401 }
    );
  }

  if (!isParticipant(conversation, session.address)) {
    return NextResponse.json(
      { error: "not_participant", message: "Not a participant of this conversation." },
      { status: 403 }
    );
  }

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
      "X-Access-Reason": "participant",
      "Cache-Control": "private, no-store"
    }
  });
});

function escapeFilename(name: string) {
  return name.replace(/[\r\n"]/g, "_");
}
