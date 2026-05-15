// Conversation message stream.
//
//   GET  → list messages in this conversation, also upserts the viewer's
//          lastSeen cursor (clears the unread badge)
//   POST → send a new message (text or multipart with a single image
//          attachment, mirroring the old OrderChatPanel UX)
//
// Only the two participants can read or write. There is no admin-readonly
// equivalent here — direct messages are private to the pair. Disputed
// orders still have their own evidence channel for support context.

import { randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { getSession } from "@/lib/auth/siwe";
import { counterpartyOf, isParticipant, lowerAddress } from "@/lib/conversations";
import { prisma } from "@/lib/db";
import { queueNotification } from "@/lib/email/send";
import { buildStorageKey, getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const MAX_BODY_CHARS = 8000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic"
]);

// Per-wallet rate limit: same shape as the old chat send. In-memory only —
// noted in follow-ups that this needs Redis once we run more than one node.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const sendHits = new Map<string, { count: number; resetAt: number }>();

function checkSendRateLimit(address: string): boolean {
  const now = Date.now();
  const key = lowerAddress(address);
  const current = sendHits.get(key);
  if (!current || current.resetAt <= now) {
    sendHits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) return false;
  current.count += 1;
  return true;
}

function attachmentUrl(conversationId: string, messageId: string) {
  return `/api/conversations/${conversationId}/messages/${messageId}/file`;
}

type MessageRow = {
  id: string;
  conversationId: string;
  senderAddress: string;
  body: string;
  createdAt: Date;
  attachmentKey: string | null;
  attachmentContentType: string | null;
  attachmentFileName: string | null;
  attachmentSize: number | null;
};

function serializeMessage(m: MessageRow) {
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
          url: attachmentUrl(m.conversationId, m.id)
        }
      : undefined
  };
}

type LoadedConversation =
  | {
      ok: true;
      conv: NonNullable<Awaited<ReturnType<typeof prisma.conversation.findUnique>>>;
    }
  | { ok: false; status: 404 | 403; message: string };

async function loadConversationForViewer(
  conversationId: string,
  viewer: string
): Promise<LoadedConversation> {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) return { ok: false, status: 404, message: "Conversation not found" };
  if (!isParticipant(conv, viewer)) {
    return { ok: false, status: 403, message: "Not a participant of this conversation" };
  }
  return { ok: true, conv };
}

export const GET = withErrorBoundary(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Not authenticated. Sign in with Ethereum first." },
      { status: 401 }
    );
  }

  const loaded = await loadConversationForViewer(id, session.address);
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.message }, { status: loaded.status });
  }

  const afterRaw = request.nextUrl.searchParams.get("after");
  let afterDate: Date | undefined;
  if (afterRaw) {
    const t = Date.parse(afterRaw);
    if (!Number.isNaN(t)) afterDate = new Date(t);
  }

  const messages = await prisma.conversationMessage.findMany({
    where: {
      conversationId: id,
      ...(afterDate ? { createdAt: { gt: afterDate } } : {})
    },
    orderBy: { createdAt: "asc" }
  });

  // Fire-and-forget lastSeen update. Hits a single composite PK row.
  // We never block the response on it: a stale cursor only means the
  // unread badge stays one tick behind, which the next poll will fix.
  void prisma.conversationLastSeen
    .upsert({
      where: {
        walletAddress_conversationId: {
          walletAddress: lowerAddress(session.address),
          conversationId: id
        }
      },
      create: {
        walletAddress: lowerAddress(session.address),
        conversationId: id,
        lastSeenAt: new Date()
      },
      update: { lastSeenAt: new Date() }
    })
    .catch(() => undefined);

  return NextResponse.json({
    messages: messages.map(serializeMessage),
    conversation: {
      id: loaded.conv.id,
      chainId: loaded.conv.chainId,
      participantA: loaded.conv.participantA,
      participantB: loaded.conv.participantB,
      counterparty: counterpartyOf(loaded.conv, session.address),
      initialProductId: loaded.conv.initialProductId
    }
  });
});

type ParsedSend =
  | {
      ok: true;
      body: string;
      file?: { buffer: Buffer; contentType: string; fileName: string; size: number };
    }
  | { ok: false; status: number; error: string };

async function parseSendBody(request: NextRequest): Promise<ParsedSend> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return { ok: false, status: 400, error: "Malformed multipart body" };
    }
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

    if (!file) return { ok: true, body };

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
      body,
      file: {
        buffer,
        contentType: file.type,
        fileName: file.name,
        size: buffer.length
      }
    };
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Request body must be JSON or multipart/form-data"
    };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, status: 400, error: "Body must be an object" };
  }
  const { body: bodyRaw } = payload as { body?: unknown };
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
  return { ok: true, body };
}

export const POST = withErrorBoundary(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Not authenticated. Sign in with Ethereum first." },
      { status: 401 }
    );
  }

  if (!checkSendRateLimit(session.address)) {
    return NextResponse.json(
      { error: "Too many messages. Slow down and try again in a minute." },
      { status: 429 }
    );
  }

  const loaded = await loadConversationForViewer(id, session.address);
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.message }, { status: loaded.status });
  }

  const parsed = await parseSendBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const senderAddress = lowerAddress(session.address);
  const messageId = randomBytes(32).toString("base64url");

  // Write the attachment first so a mid-flight crash leaves an orphan blob
  // rather than a DB row pointing at nothing.
  let attachment:
    | { key: string; backend: string; contentType: string; fileName: string; size: number }
    | undefined;
  if (parsed.file) {
    const storage = getStorage();
    // Reuse the storage key shape from the old chat: conversationId fills
    // the slot that used to hold chainId/orderId so files don't collide
    // across conversations.
    const key = buildStorageKey(loaded.conv.chainId, loaded.conv.id, messageId, parsed.file.fileName);
    const stored = await storage.put(key, parsed.file.buffer, parsed.file.contentType);
    attachment = {
      key: stored.key,
      backend: stored.backend,
      contentType: parsed.file.contentType,
      fileName: parsed.file.fileName,
      size: stored.size
    };
  }

  // Insert message + bump conversation.lastMessageAt in one transaction so
  // the sidebar sort order can never lag the actual message arrival.
  const now = new Date();
  const [created] = await prisma.$transaction([
    prisma.conversationMessage.create({
      data: {
        id: messageId,
        conversationId: loaded.conv.id,
        senderAddress,
        body: parsed.body,
        createdAt: now,
        attachmentKey: attachment?.key,
        attachmentBackend: attachment?.backend,
        attachmentContentType: attachment?.contentType,
        attachmentFileName: attachment?.fileName,
        attachmentSize: attachment?.size
      }
    }),
    prisma.conversation.update({
      where: { id: loaded.conv.id },
      data: { lastMessageAt: now }
    })
  ]);

  // Sender just opened the thread to send — bump their lastSeen so the
  // outgoing message isn't counted as their own "unread".
  void prisma.conversationLastSeen
    .upsert({
      where: {
        walletAddress_conversationId: {
          walletAddress: senderAddress,
          conversationId: loaded.conv.id
        }
      },
      create: {
        walletAddress: senderAddress,
        conversationId: loaded.conv.id,
        lastSeenAt: now
      },
      update: { lastSeenAt: now }
    })
    .catch(() => undefined);

  // Notify the counterparty. The email template treats this kind as
  // "someone sent you a direct message" and links back to /messages.
  try {
    const recipient = counterpartyOf(loaded.conv, session.address);
    queueNotification(
      recipient,
      "NewDirectMessage",
      { chainId: loaded.conv.chainId, onChainOrderId: loaded.conv.id },
      "v3"
    );
  } catch {
    // Best-effort.
  }

  return NextResponse.json(
    { message: serializeMessage(created) },
    { status: 201 }
  );
});
