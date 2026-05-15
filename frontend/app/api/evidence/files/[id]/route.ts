import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { authorizeForOrder, type MarketplaceVersion } from "@/lib/auth/authorize";
import { getSession } from "@/lib/auth/siwe";
import { prisma } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id || id.length > 64) {
    return NextResponse.json({ error: "Invalid evidence id" }, { status: 400 });
  }

  const evidence = await prisma.evidenceUpload.findUnique({ where: { id } });
  if (!evidence) {
    return NextResponse.json({ error: "Evidence not found" }, { status: 404 });
  }

  const session = await getSession();
  const viewer = session?.address ?? null;

  // If the request explicitly comes from a browser navigation and the viewer
  // is not authenticated, redirect to the viewer page rather than returning
  // raw JSON. Helps Kleros jurors who click the URL from the Kleros UI:
  // they land on a wallet-connect page instead of a 401 dump.
  const accept = request.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html");

  const grant = await authorizeForOrder(
    viewer,
    evidence.chainId,
    evidence.onChainOrderId,
    evidence.marketplaceVersion as MarketplaceVersion
  );

  if (!grant.allowed) {
    if (wantsHtml) {
      const next = encodeURIComponent(`/api/evidence/files/${id}`);
      return NextResponse.redirect(new URL(`/evidence/view/${id}?next=${next}`, request.url));
    }
    const status = grant.reason === "no_session" ? 401 : 403;
    return NextResponse.json(
      {
        error: grant.reason,
        detail: "detail" in grant ? grant.detail : undefined,
        message:
          grant.reason === "no_session"
            ? "Sign in with Ethereum first."
            : "Not authorized to view this evidence."
      },
      { status }
    );
  }

  const storage = getStorage();
  if (evidence.storageBackend !== storage.backend) {
    // The row was written under a different backend than the current process
    // is configured for. Don't pretend we can serve it; 410 is more honest.
    return NextResponse.json(
      {
        error: "storage_backend_mismatch",
        detail: `Stored with ${evidence.storageBackend}, server now uses ${storage.backend}.`
      },
      { status: 410 }
    );
  }

  const buffer = await storage.get(evidence.storageKey);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": evidence.contentType,
      "Content-Length": String(evidence.size),
      "Content-Disposition": `inline; filename="${escapeFilename(evidence.fileName)}"`,
      // Surface the access reason to the client for UI hints — not security-
      // critical, just nice for debugging.
      "X-Access-Reason": grant.reason,
      // Don't let CDNs cache private content.
      "Cache-Control": "private, no-store"
    }
  });
});

function escapeFilename(name: string) {
  return name.replace(/[\r\n"]/g, "_");
}
