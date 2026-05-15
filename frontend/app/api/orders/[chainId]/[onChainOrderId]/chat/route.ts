// Per-order private chat between buyer and seller.
//
//   GET  → list messages (party + admin can read, Kleros juror inherits via
//          authorizeForOrder so a drawn juror can also follow the thread).
//          Also upserts the viewer's OrderChatLastSeen cursor so /api/inbox
//          can compute unread counts.
//   POST → send a message (only buyer/seller; admin reads but never writes,
//          to keep support out of pretending to be either party). Accepts
//          either JSON `{ version, body }` (text-only path) or multipart
//          `version` + `body` + optional `file` (image attachment, max 5MB).
//
// Front-end polls GET on a 5s interval; we don't push. After a successful
// POST we queue a "NewChatMessage" email to the counterparty (1h dedup
// override lives in lib/email/send.ts).

import { randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { authorizeForOrder, isOrderParty, type MarketplaceVersion } from "@/lib/auth/authorize";
import { getSession } from "@/lib/auth/siwe";
import { prisma } from "@/lib/db";
import { queueNotification } from "@/lib/email/send";
import { getOrder } from "@/lib/orders";
import { buildStorageKey, getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ chainId: string; onChainOrderId: string }>;
};

const MAX_BODY_CHARS = 8000;
// 5 MB. Lower than evidence's 10 MB cap — chat is conversational, not
// dispute-evidence dumping; if the user has a 10 MB scan to share it
// belongs in the EvidenceRegistry flow with the on-chain content hash.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic"
]);

// Rate limit: 30 messages per wallet per rolling 60 seconds. Lives in module
// memory — fine for a single dev/server process; in a multi-node deploy
// this would need to move to Redis (noted in follow-ups).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const sendHits = new Map<string, { count: number; resetAt: number }>();

function checkSendRateLimit(address: string): boolean {
  const now = Date.now();
  const key = address.toLowerCase();
  const current = sendHits.get(key);
  if (!current || current.resetAt <= now) {
    sendHits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) return false;
  current.count += 1;
  return true;
}

function parseVersion(raw: string | null | undefined): MarketplaceVersion {
  return raw === "v3.1" ? "v3.1" : "v3";
}

function parseRouteParams(params: { chainId: string; onChainOrderId: string }) {
  const chainId = Number(params.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { error: "Invalid chainId" } as const;
  }
  if (!/^[1-9]\d*$/.test(params.onChainOrderId)) {
    return { error: "Invalid order id" } as const;
  }
  return { chainId, onChainOrderId: params.onChainOrderId } as const;
}

// Builds the per-message attachment URL the client uses to fetch the bytes.
// The endpoint is auth-gated (authorizeForOrder), so this URL is safe to
// include in JSON returned to all authorized viewers.
function attachmentUrl(chainId: number, onChainOrderId: string, messageId: string) {
  return `/api/orders/${chainId}/${onChainOrderId}/chat/${messageId}/file`;
}

type ChatMessageRow = {
  id: string;
  senderAddress: string;
  body: string;
  createdAt: Date;
  attachmentContentType: string | null;
  attachmentFileName: string | null;
  attachmentSize: number | null;
  attachmentKey: string | null;
};

function serializeMessage(chainId: number, onChainOrderId: string, m: ChatMessageRow) {
  const hasAttachment = m.attachmentKey !== null;
  return {
    id: m.id,
    senderAddress: m.senderAddress,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    attachment: hasAttachment
      ? {
          contentType: m.attachmentContentType ?? "application/octet-stream",
          fileName: m.attachmentFileName ?? "file",
          size: m.attachmentSize ?? 0,
          url: attachmentUrl(chainId, onChainOrderId, m.id)
        }
      : undefined
  };
}

export const GET = withErrorBoundary(async (request: NextRequest, context: RouteContext) => {
  const raw = await context.params;
  const route = parseRouteParams(raw);
  if ("error" in route) {
    return NextResponse.json({ error: route.error }, { status: 400 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated. Sign in with Ethereum first." }, { status: 401 });
  }

  const version = parseVersion(request.nextUrl.searchParams.get("version"));
  const grant = await authorizeForOrder(session.address, route.chainId, route.onChainOrderId, version);
  if (!grant.allowed) {
    const status = grant.reason === "no_session" ? 401 : 403;
    return NextResponse.json(
      { error: grant.reason, message: "Not authorized to view this chat." },
      { status }
    );
  }

  // Optional incremental fetch: only return messages strictly newer than the
  // client's last known timestamp. Keeps the polling response cheap once a
  // thread has many messages.
  const afterRaw = request.nextUrl.searchParams.get("after");
  let afterDate: Date | undefined;
  if (afterRaw) {
    const t = Date.parse(afterRaw);
    if (!Number.isNaN(t)) afterDate = new Date(t);
  }

  const messages = await prisma.orderChatMessage.findMany({
    where: {
      chainId: route.chainId,
      onChainOrderId: route.onChainOrderId,
      marketplaceVersion: version,
      ...(afterDate ? { createdAt: { gt: afterDate } } : {})
    },
    orderBy: { createdAt: "asc" }
  });

  // Fire-and-forget lastSeen update. Doing this on every poll is wasteful
  // (writes 12x/minute per open tab), but for an MVP it's fine — the table
  // is tiny and the upsert hits a single PK. If this becomes a hot spot,
  // throttle to "last write was more than 30s ago" before issuing the
  // upsert. Critically, we never block or fail the GET on this — a failed
  // upsert just leaves the unread count stale until the next poll.
  void prisma.orderChatLastSeen
    .upsert({
      where: {
        walletAddress_chainId_onChainOrderId_marketplaceVersion: {
          walletAddress: session.address.toLowerCase(),
          chainId: route.chainId,
          onChainOrderId: route.onChainOrderId,
          marketplaceVersion: version
        }
      },
      create: {
        walletAddress: session.address.toLowerCase(),
        chainId: route.chainId,
        onChainOrderId: route.onChainOrderId,
        marketplaceVersion: version,
        lastSeenAt: new Date()
      },
      update: { lastSeenAt: new Date() }
    })
    .catch(() => {
      // Best-effort — non-critical.
    });

  return NextResponse.json({
    messages: messages.map((m) => serializeMessage(route.chainId, route.onChainOrderId, m))
  });
});

type ParsedInput =
  | {
      ok: true;
      version: MarketplaceVersion;
      body: string;
      file?: { buffer: Buffer; contentType: string; fileName: string; size: number };
    }
  | { ok: false; status: number; error: string };

async function parseRequestBody(request: NextRequest): Promise<ParsedInput> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return { ok: false, status: 400, error: "Malformed multipart body" };
    }

    const version = parseVersion(form.get("version") as string | null);
    const bodyRaw = (form.get("body") as string | null) ?? "";
    const body = bodyRaw.trim();

    const fileField = form.get("file");
    const file = fileField instanceof File && fileField.size > 0 ? fileField : undefined;

    if (body.length === 0 && !file) {
      return { ok: false, status: 400, error: "Message cannot be empty" };
    }
    if (body.length > MAX_BODY_CHARS) {
      return { ok: false, status: 400, error: `Message exceeds ${MAX_BODY_CHARS} characters.` };
    }

    if (!file) {
      return { ok: true, version, body };
    }

    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported attachment type "${file.type}". Allowed: JPEG / PNG / WebP / GIF / HEIC.`
      };
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, status: 400, error: "Attachment exceeds 5 MB." };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    return {
      ok: true,
      version,
      body,
      file: {
        buffer,
        contentType: file.type,
        fileName: file.name,
        size: buffer.length
      }
    };
  }

  // JSON path — preserves the original text-only contract.
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { ok: false, status: 400, error: "Request body must be JSON or multipart/form-data" };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, status: 400, error: "Body must be an object" };
  }
  const { version: versionRaw, body: bodyRaw } = payload as { version?: unknown; body?: unknown };
  const version = parseVersion(typeof versionRaw === "string" ? versionRaw : null);
  if (typeof bodyRaw !== "string") {
    return { ok: false, status: 400, error: "body must be a string" };
  }
  const body = bodyRaw.trim();
  if (body.length === 0) {
    return { ok: false, status: 400, error: "Message cannot be empty" };
  }
  if (body.length > MAX_BODY_CHARS) {
    return { ok: false, status: 400, error: `Message exceeds ${MAX_BODY_CHARS} characters.` };
  }
  return { ok: true, version, body };
}

export const POST = withErrorBoundary(async (request: NextRequest, context: RouteContext) => {
  const raw = await context.params;
  const route = parseRouteParams(raw);
  if ("error" in route) {
    return NextResponse.json({ error: route.error }, { status: 400 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated. Sign in with Ethereum first." }, { status: 401 });
  }

  if (!checkSendRateLimit(session.address)) {
    return NextResponse.json(
      { error: "Too many messages. Slow down and try again in a minute." },
      { status: 429 }
    );
  }

  const parsed = await parseRequestBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  // Only the buyer/seller can post. Admins reading the thread are deliberately
  // excluded so support can't impersonate a party.
  const isParty = await isOrderParty(session.address, route.chainId, route.onChainOrderId, parsed.version);
  if (!isParty) {
    return NextResponse.json(
      { error: "Only the buyer or seller of this order can send messages here." },
      { status: 403 }
    );
  }

  // Need buyer+seller from the order for the email recipient.
  const order = await getOrder(route.chainId, route.onChainOrderId, parsed.version);
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const senderAddress = session.address.toLowerCase();
  const id = randomBytes(32).toString("base64url");

  // If we have an attachment, write it to storage BEFORE the DB insert so a
  // crash mid-flight leaves an orphan blob (cheap) rather than a DB row
  // pointing at a missing key (broken UI).
  let attachment: {
    key: string;
    backend: string;
    contentType: string;
    fileName: string;
    size: number;
  } | undefined;
  if (parsed.file) {
    const storage = getStorage();
    const key = buildStorageKey(route.chainId, route.onChainOrderId, id, parsed.file.fileName);
    const stored = await storage.put(key, parsed.file.buffer, parsed.file.contentType);
    attachment = {
      key: stored.key,
      backend: stored.backend,
      contentType: parsed.file.contentType,
      fileName: parsed.file.fileName,
      size: stored.size
    };
  }

  const created = await prisma.orderChatMessage.create({
    data: {
      id,
      chainId: route.chainId,
      onChainOrderId: route.onChainOrderId,
      marketplaceVersion: parsed.version,
      senderAddress,
      body: parsed.body,
      attachmentKey: attachment?.key,
      attachmentBackend: attachment?.backend,
      attachmentContentType: attachment?.contentType,
      attachmentFileName: attachment?.fileName,
      attachmentSize: attachment?.size
    }
  });

  // Sender opening the chat just sent a message → bump their lastSeen so we
  // don't show them an unread count for their own outgoing message.
  void prisma.orderChatLastSeen
    .upsert({
      where: {
        walletAddress_chainId_onChainOrderId_marketplaceVersion: {
          walletAddress: senderAddress,
          chainId: route.chainId,
          onChainOrderId: route.onChainOrderId,
          marketplaceVersion: parsed.version
        }
      },
      create: {
        walletAddress: senderAddress,
        chainId: route.chainId,
        onChainOrderId: route.onChainOrderId,
        marketplaceVersion: parsed.version,
        lastSeenAt: new Date()
      },
      update: { lastSeenAt: new Date() }
    })
    .catch(() => undefined);

  // Fire-and-forget email to the other party.
  try {
    const buyer = order.buyer.toLowerCase();
    const seller = order.seller.toLowerCase();
    const counterparty = senderAddress === buyer ? seller : buyer;
    queueNotification(
      counterparty,
      "NewChatMessage",
      { chainId: route.chainId, onChainOrderId: route.onChainOrderId },
      parsed.version
    );
  } catch {
    // Best-effort notification; ignore.
  }

  return NextResponse.json(
    {
      message: serializeMessage(route.chainId, route.onChainOrderId, created)
    },
    { status: 201 }
  );
});
