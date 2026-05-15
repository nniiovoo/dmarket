// Per-user inbox: all orders the caller participates in (as buyer or seller,
// across V3 + V3.1), each with its latest chat message + unread count.
//
// Sorted by latest message time DESC, NULLS LAST — so noisy threads bubble
// up first, dormant orders sink. Capped at 50 rows; if a heavy user ever
// hits that limit we'd page or filter by "only with unread".
//
// Implementation note: a single raw SQL CTE is the cleanest way to express
// the four-way join (orders × latest message × last-seen cursor × unread
// count) without N+1 queries. If order count per user ever blows past a
// few thousand this query needs revisiting (materialized view or per-user
// cache); for an MVP it's well within Postgres territory.

import { NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { getSession } from "@/lib/auth/siwe";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const INBOX_LIMIT = 50;
const PREVIEW_CHARS = 80;

type InboxRow = {
  chainId: number;
  onChainOrderId: string;
  marketplaceVersion: string;
  counterparty: string;
  counterparty_role: "buyer" | "seller";
  order_status: string;
  last_id: string | null;
  last_sender: string | null;
  last_body: string | null;
  last_created_at: Date | null;
  last_has_attachment: boolean | null;
  unread_count: bigint | number | null;
};

export const GET = withErrorBoundary(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Not authenticated. Sign in with Ethereum first." },
      { status: 401 }
    );
  }

  const wallet = session.address.toLowerCase();

  // The CTE pipeline:
  //   user_orders   — every (chainId, orderId, version) where the viewer is
  //                   a party, drawn from both order tables.
  //   last_message  — most-recent message per thread.
  //   last_seen     — viewer's read cursor per thread (may be NULL if they
  //                   never opened it before).
  //   unread_counts — count of messages NOT sent by the viewer that arrived
  //                   after their lastSeenAt (or all, if cursor missing).
  const rows = await prisma.$queryRaw<InboxRow[]>`
    WITH user_orders AS (
      SELECT
        "chainId",
        "onChainOrderId",
        'v3'::text AS "marketplaceVersion",
        LOWER("buyer")  AS buyer_lower,
        LOWER("seller") AS seller_lower,
        "status"
      FROM "OnChainOrder"
      WHERE LOWER("buyer") = ${wallet} OR LOWER("seller") = ${wallet}
      UNION ALL
      SELECT
        "chainId",
        "onChainOrderId",
        'v3.1'::text AS "marketplaceVersion",
        LOWER("buyer")  AS buyer_lower,
        LOWER("seller") AS seller_lower,
        "status"
      FROM "OnChainOrderV3_1"
      WHERE LOWER("buyer") = ${wallet} OR LOWER("seller") = ${wallet}
    ),
    last_message AS (
      SELECT DISTINCT ON ("chainId", "onChainOrderId", "marketplaceVersion")
        "chainId",
        "onChainOrderId",
        "marketplaceVersion",
        "id"            AS last_id,
        "senderAddress" AS last_sender,
        "body"          AS last_body,
        "createdAt"     AS last_created_at,
        ("attachmentKey" IS NOT NULL) AS last_has_attachment
      FROM "OrderChatMessage"
      ORDER BY "chainId", "onChainOrderId", "marketplaceVersion", "createdAt" DESC
    ),
    unread_counts AS (
      SELECT
        m."chainId",
        m."onChainOrderId",
        m."marketplaceVersion",
        COUNT(*) AS unread_count
      FROM "OrderChatMessage" m
      LEFT JOIN "OrderChatLastSeen" ls
        ON ls."walletAddress"      = ${wallet}
       AND ls."chainId"            = m."chainId"
       AND ls."onChainOrderId"     = m."onChainOrderId"
       AND ls."marketplaceVersion" = m."marketplaceVersion"
      WHERE m."senderAddress" <> ${wallet}
        AND (ls."lastSeenAt" IS NULL OR m."createdAt" > ls."lastSeenAt")
      GROUP BY m."chainId", m."onChainOrderId", m."marketplaceVersion"
    )
    SELECT
      o."chainId"            AS "chainId",
      o."onChainOrderId"     AS "onChainOrderId",
      o."marketplaceVersion" AS "marketplaceVersion",
      CASE WHEN o.buyer_lower = ${wallet} THEN o.seller_lower ELSE o.buyer_lower END  AS counterparty,
      CASE WHEN o.buyer_lower = ${wallet} THEN 'seller' ELSE 'buyer' END              AS counterparty_role,
      o."status"             AS order_status,
      lm.last_id,
      lm.last_sender,
      lm.last_body,
      lm.last_created_at,
      lm.last_has_attachment,
      COALESCE(uc.unread_count, 0) AS unread_count
    FROM user_orders o
    LEFT JOIN last_message  lm
      ON lm."chainId"            = o."chainId"
     AND lm."onChainOrderId"     = o."onChainOrderId"
     AND lm."marketplaceVersion" = o."marketplaceVersion"
    LEFT JOIN unread_counts uc
      ON uc."chainId"            = o."chainId"
     AND uc."onChainOrderId"     = o."onChainOrderId"
     AND uc."marketplaceVersion" = o."marketplaceVersion"
    ORDER BY lm.last_created_at DESC NULLS LAST
    LIMIT ${INBOX_LIMIT}
  `;

  const inbox = rows.map((r) => ({
    chainId: r.chainId,
    onChainOrderId: r.onChainOrderId,
    marketplaceVersion: r.marketplaceVersion === "v3.1" ? ("v3.1" as const) : ("v3" as const),
    counterparty: r.counterparty,
    counterpartyRole: r.counterparty_role,
    orderStatus: r.order_status,
    lastMessage:
      r.last_id && r.last_created_at
        ? {
            senderAddress: r.last_sender ?? "",
            // Trim aggressive so the inbox stays readable. The recipient
            // clicks through to see the full message + attachment.
            bodyPreview: previewBody(r.last_body ?? "", r.last_has_attachment === true),
            createdAt: r.last_created_at.toISOString(),
            hasAttachment: r.last_has_attachment === true
          }
        : null,
    unreadCount: Number(r.unread_count ?? 0)
  }));

  return NextResponse.json({ inbox });
});

function previewBody(body: string, hasAttachment: boolean) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return hasAttachment ? "📎 (image)" : "";
  }
  const compact = trimmed.replace(/\s+/g, " ");
  if (compact.length <= PREVIEW_CHARS) return compact;
  return `${compact.slice(0, PREVIEW_CHARS - 1)}…`;
}
