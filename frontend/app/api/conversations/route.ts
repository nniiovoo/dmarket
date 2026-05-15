// Unified messenger top-level endpoint.
//
//   GET  → list the caller's conversations with last message + unread count
//   POST → get-or-create a conversation with another party
//
// Both require SIWE. Conversations are pairwise per chain — see
// lib/conversations.ts for the canonicalisation rule.

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { getSession } from "@/lib/auth/siwe";
import { getOrCreateConversation, lowerAddress } from "@/lib/conversations";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const INBOX_LIMIT = 100;
const PREVIEW_CHARS = 80;
const SUPPORTED_CHAIN_IDS = new Set([11155111, 80002, 421614]);

type ListRow = {
  id: string;
  chainId: number;
  participantA: string;
  participantB: string;
  initialProductId: string | null;
  createdAt: Date;
  lastMessageAt: Date;
  last_message_id: string | null;
  last_sender: string | null;
  last_body: string | null;
  last_created_at: Date | null;
  last_has_attachment: boolean | null;
  unread_count: bigint | number | null;
};

function previewBody(body: string, hasAttachment: boolean) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return hasAttachment ? "📎 (image)" : "";
  }
  const compact = trimmed.replace(/\s+/g, " ");
  if (compact.length <= PREVIEW_CHARS) return compact;
  return `${compact.slice(0, PREVIEW_CHARS - 1)}…`;
}

export const GET = withErrorBoundary(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Not authenticated. Sign in with Ethereum first." },
      { status: 401 }
    );
  }

  const wallet = lowerAddress(session.address);

  // Single raw SQL: conversations the viewer participates in, joined with
  // the most recent message per conversation, the viewer's read cursor,
  // and the count of incoming messages newer than that cursor. Conversations
  // with no messages yet are excluded — they only exist while a "Contact
  // seller" button is mid-flight, and showing them empty is just noise.
  const rows = await prisma.$queryRaw<ListRow[]>`
    WITH my_conversations AS (
      SELECT *
      FROM "Conversation"
      WHERE "participantA" = ${wallet} OR "participantB" = ${wallet}
    ),
    last_message AS (
      SELECT DISTINCT ON ("conversationId")
        "conversationId",
        "id"             AS last_message_id,
        "senderAddress"  AS last_sender,
        "body"           AS last_body,
        "createdAt"      AS last_created_at,
        ("attachmentKey" IS NOT NULL) AS last_has_attachment
      FROM "ConversationMessage"
      WHERE "conversationId" IN (SELECT id FROM my_conversations)
      ORDER BY "conversationId", "createdAt" DESC
    ),
    unread_counts AS (
      SELECT m."conversationId",
             COUNT(*) AS unread_count
      FROM "ConversationMessage" m
      LEFT JOIN "ConversationLastSeen" ls
        ON ls."walletAddress" = ${wallet}
       AND ls."conversationId" = m."conversationId"
      WHERE m."conversationId" IN (SELECT id FROM my_conversations)
        AND m."senderAddress" <> ${wallet}
        AND (ls."lastSeenAt" IS NULL OR m."createdAt" > ls."lastSeenAt")
      GROUP BY m."conversationId"
    )
    SELECT
      c.id, c."chainId", c."participantA", c."participantB",
      c."initialProductId", c."createdAt", c."lastMessageAt",
      lm.last_message_id, lm.last_sender, lm.last_body,
      lm.last_created_at, lm.last_has_attachment,
      COALESCE(uc.unread_count, 0) AS unread_count
    FROM my_conversations c
    INNER JOIN last_message  lm ON lm."conversationId" = c.id
    LEFT JOIN  unread_counts uc ON uc."conversationId" = c.id
    ORDER BY c."lastMessageAt" DESC
    LIMIT ${INBOX_LIMIT}
  `;

  const conversations = rows.map((r) => {
    const isParticipantA = r.participantA === wallet;
    const counterparty = isParticipantA ? r.participantB : r.participantA;
    return {
      id: r.id,
      chainId: r.chainId,
      counterparty,
      participantA: r.participantA,
      participantB: r.participantB,
      initialProductId: r.initialProductId,
      lastMessageAt: r.lastMessageAt.toISOString(),
      unreadCount: Number(r.unread_count ?? 0),
      lastMessage:
        r.last_message_id && r.last_created_at
          ? {
              senderAddress: r.last_sender ?? "",
              bodyPreview: previewBody(r.last_body ?? "", r.last_has_attachment === true),
              createdAt: r.last_created_at.toISOString(),
              hasAttachment: r.last_has_attachment === true,
              mine: r.last_sender === wallet
            }
          : null
    };
  });

  return NextResponse.json({ conversations });
});

export const POST = withErrorBoundary(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Not authenticated. Sign in with Ethereum first." },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const { chainId: chainIdRaw, otherParty: otherPartyRaw, productId: productIdRaw } = payload as {
    chainId?: unknown;
    otherParty?: unknown;
    productId?: unknown;
  };

  if (typeof chainIdRaw !== "number" || !Number.isInteger(chainIdRaw) || !SUPPORTED_CHAIN_IDS.has(chainIdRaw)) {
    return NextResponse.json(
      { error: "chainId must be a supported chain integer" },
      { status: 400 }
    );
  }
  if (typeof otherPartyRaw !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(otherPartyRaw)) {
    return NextResponse.json(
      { error: "otherParty must be a 20-byte hex address" },
      { status: 400 }
    );
  }
  const initialProductId =
    typeof productIdRaw === "string" && /^[1-9]\d*$/.test(productIdRaw) ? productIdRaw : undefined;

  if (lowerAddress(otherPartyRaw) === lowerAddress(session.address)) {
    return NextResponse.json(
      { error: "Cannot start a conversation with yourself." },
      { status: 400 }
    );
  }

  const conversation = await getOrCreateConversation({
    chainId: chainIdRaw,
    initiator: session.address,
    otherParty: otherPartyRaw,
    initialProductId
  });

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      chainId: conversation.chainId,
      counterparty: lowerAddress(otherPartyRaw),
      participantA: conversation.participantA,
      participantB: conversation.participantB,
      initialProductId: conversation.initialProductId,
      createdAt: conversation.createdAt.toISOString(),
      lastMessageAt: conversation.lastMessageAt.toISOString()
    }
  });
});
