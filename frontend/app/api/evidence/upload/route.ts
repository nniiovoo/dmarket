import { randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { getSession } from "@/lib/auth/siwe";
import { isOrderParty } from "@/lib/auth/authorize";
import { prisma } from "@/lib/db";
import {
  type EvidenceAttachment,
  type EvidenceManifestV1,
  EVIDENCE_PACKAGE_CONTENT_TYPE
} from "@/lib/evidencePackage";
import { buildStorageKey, getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

// One submission = one manifest containing 0..N attachments + text. Caps
// apply both per-file and per-package to keep abuse off our R2 bill.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_DESCRIPTION_CHARS = 8000;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "application/pdf",
  "text/plain"
]);

const rateLimitWindowMs = 60_000;
const maxUploadsPerWindow = 6;
const uploadHits = new Map<string, { count: number; resetAt: number }>();

export const POST = withErrorBoundary(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Not authenticated. Sign in with Ethereum first." },
      { status: 401 }
    );
  }

  const rateLimit = checkRateLimit(session.address.toLowerCase());
  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: "Too many uploads. Wait a minute and try again." },
      { status: 429 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Request must be multipart/form-data" },
      { status: 400 }
    );
  }

  const chainIdRaw = form.get("chainId");
  const onChainOrderId = form.get("onChainOrderId");
  const description = (form.get("description") as string | null) ?? "";
  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  // Optional — when V3.1 dialog submits, it sets this to "v3.1". Default "v3"
  // matches the existing V3 callers that never had this field.
  const marketplaceVersionRaw = form.get("marketplaceVersion");
  const marketplaceVersion: "v3" | "v3.1" =
    marketplaceVersionRaw === "v3.1" ? "v3.1" : "v3";

  if (typeof chainIdRaw !== "string" || typeof onChainOrderId !== "string") {
    return NextResponse.json(
      { error: "chainId and onChainOrderId are required form fields" },
      { status: 400 }
    );
  }
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId)) {
    return NextResponse.json({ error: "chainId must be an integer" }, { status: 400 });
  }

  if (description.length > MAX_DESCRIPTION_CHARS) {
    return NextResponse.json(
      { error: `Description exceeds ${MAX_DESCRIPTION_CHARS} characters.` },
      { status: 400 }
    );
  }
  if (description.trim().length === 0 && files.length === 0) {
    return NextResponse.json(
      { error: "Provide a description, one or more files, or both." },
      { status: 400 }
    );
  }
  if (files.length > MAX_ATTACHMENTS) {
    return NextResponse.json(
      { error: `At most ${MAX_ATTACHMENTS} files per submission.` },
      { status: 400 }
    );
  }

  let totalBytes = 0;
  for (const f of files) {
    if (f.size === 0) {
      return NextResponse.json({ error: `Empty file: ${f.name}` }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(f.type)) {
      return NextResponse.json(
        { error: `Unsupported type "${f.type}" for ${f.name}. Allowed: JPEG/PNG/WebP/GIF/HEIC/PDF/text.` },
        { status: 400 }
      );
    }
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `${f.name} is larger than 10 MB.` },
        { status: 400 }
      );
    }
    totalBytes += f.size;
  }
  if (totalBytes > MAX_PACKAGE_BYTES) {
    return NextResponse.json(
      { error: "Total submission size exceeds 25 MB." },
      { status: 400 }
    );
  }

  const isParty = await isOrderParty(session.address, chainId, onChainOrderId, marketplaceVersion);
  if (!isParty) {
    return NextResponse.json(
      { error: "Only the buyer or seller of this order can upload evidence." },
      { status: 403 }
    );
  }

  const storage = getStorage();
  const attachments: EvidenceAttachment[] = [];

  // 1) Upload each attachment, record one EvidenceUpload row each.
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileId = randomBytes(16).toString("base64url");
    const key = buildStorageKey(chainId, onChainOrderId, fileId, file.name);
    const stored = await storage.put(key, buffer, file.type);

    await prisma.evidenceUpload.create({
      data: {
        id: fileId,
        chainId,
        onChainOrderId,
        marketplaceVersion,
        contentHash: stored.contentHash,
        storageKey: stored.key,
        storageBackend: stored.backend,
        fileName: file.name,
        contentType: file.type,
        size: stored.size,
        uploadedBy: session.address.toLowerCase()
      }
    });

    attachments.push({
      fileId,
      fileName: file.name,
      contentType: file.type,
      size: stored.size,
      contentHash: stored.contentHash
    });
  }

  // 2) Build + upload the manifest. The on-chain submitEvidence URI points
  // to this manifest, not to any individual attachment.
  const manifest: EvidenceManifestV1 = {
    version: 1,
    kind: "chainus-dispute-evidence",
    chainId,
    onChainOrderId,
    description: description.trim(),
    submittedBy: session.address.toLowerCase(),
    submittedAt: new Date().toISOString(),
    attachments
  };

  const manifestId = randomBytes(16).toString("base64url");
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const manifestKey = buildStorageKey(chainId, onChainOrderId, manifestId, "manifest.json");
  const manifestStored = await storage.put(manifestKey, manifestBuffer, EVIDENCE_PACKAGE_CONTENT_TYPE);

  await prisma.evidenceUpload.create({
    data: {
      id: manifestId,
      chainId,
      onChainOrderId,
      marketplaceVersion,
      contentHash: manifestStored.contentHash,
      storageKey: manifestStored.key,
      storageBackend: manifestStored.backend,
      fileName: "manifest.json",
      contentType: EVIDENCE_PACKAGE_CONTENT_TYPE,
      size: manifestStored.size,
      uploadedBy: session.address.toLowerCase()
    }
  });

  const origin = request.nextUrl.origin;
  const uri = `${origin}/api/evidence/files/${manifestId}`;

  return NextResponse.json({
    manifestId,
    uri,
    contentHash: manifestStored.contentHash,
    attachmentCount: attachments.length,
    description: manifest.description,
    totalBytes
  });
});

function checkRateLimit(key: string) {
  const now = Date.now();
  const current = uploadHits.get(key);
  if (!current || current.resetAt <= now) {
    uploadHits.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    return { ok: true };
  }
  if (current.count >= maxUploadsPerWindow) return { ok: false };
  current.count += 1;
  return { ok: true };
}
