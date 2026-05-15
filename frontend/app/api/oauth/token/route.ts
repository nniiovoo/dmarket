// POST /oauth/token  (routed via /api/oauth/token; .well-known points here)
//
// Exchanges a one-time authorization code for an HS256 JWT bearer.
//
// Body (application/x-www-form-urlencoded OR JSON):
//   grant_type=authorization_code
//   code=<code from /oauth/grant>
//   redirect_uri=<must match the one used at /oauth/authorize>
//   client_id=<client>
//   client_secret=<secret>   (or HTTP Basic auth)
//   code_verifier=<PKCE>     (required iff code_challenge was sent)

import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import {
  OAUTH_JWT_DEFAULT_TTL_SECONDS,
  OAuthConfigError,
  signOAuthJwt
} from "@/lib/ai/auth";
import { findClient } from "@/lib/ai/oauthClients";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

interface TokenRequest {
  grantType: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier?: string;
}

async function parseBody(request: NextRequest): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }
  const json = await request.json();
  if (!json || typeof json !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(json)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function decodeBasicAuth(header: string | null): { id: string; secret: string } | null {
  if (!header || !header.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function safeStrEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === "plain") return safeStrEq(verifier, challenge);
  if (method === "S256") {
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    return safeStrEq(expected, challenge);
  }
  return false;
}

export const POST = withErrorBoundary(async (request: NextRequest) => {
  const body = await parseBody(request);
  const basic = decodeBasicAuth(request.headers.get("authorization"));

  const req: TokenRequest = {
    grantType: body["grant_type"] ?? "",
    code: body["code"] ?? "",
    redirectUri: body["redirect_uri"] ?? "",
    clientId: body["client_id"] ?? basic?.id ?? "",
    clientSecret: body["client_secret"] ?? basic?.secret ?? "",
    codeVerifier: body["code_verifier"]
  };

  if (req.grantType !== "authorization_code") {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  if (!req.code || !req.redirectUri || !req.clientId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const client = findClient(req.clientId);
  if (!client) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }
  if (!safeStrEq(client.secret, req.clientSecret)) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }

  const codeRow = await prisma.oAuthAuthorizationCode.findUnique({ where: { code: req.code } });
  if (!codeRow) return NextResponse.json({ error: "invalid_grant", reason: "unknown_code" }, { status: 400 });
  if (codeRow.consumedAt !== null) {
    // Single-use enforcement. A replayed code is suspicious enough that we
    // also invalidate any token we may have just issued — but for MVP a
    // hard 400 is sufficient (the JWT can't be revoked, but its TTL is
    // finite and the buyer can re-authorize).
    return NextResponse.json({ error: "invalid_grant", reason: "code_replayed" }, { status: 400 });
  }
  if (codeRow.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "invalid_grant", reason: "code_expired" }, { status: 400 });
  }
  if (codeRow.clientId !== req.clientId) {
    return NextResponse.json({ error: "invalid_grant", reason: "client_mismatch" }, { status: 400 });
  }
  if (codeRow.redirectUri !== req.redirectUri) {
    return NextResponse.json({ error: "invalid_grant", reason: "redirect_mismatch" }, { status: 400 });
  }
  if (codeRow.codeChallenge) {
    if (!req.codeVerifier) {
      return NextResponse.json({ error: "invalid_grant", reason: "missing_code_verifier" }, { status: 400 });
    }
    const method = codeRow.codeChallengeMethod ?? "plain";
    if (!verifyPkce(req.codeVerifier, codeRow.codeChallenge, method)) {
      return NextResponse.json({ error: "invalid_grant", reason: "bad_code_verifier" }, { status: 400 });
    }
  }

  // Consume the code first; on any later error we don't want the same
  // code to be redeemable again.
  await prisma.oAuthAuthorizationCode.update({
    where: { code: req.code },
    data: { consumedAt: new Date() }
  });

  let accessToken: string;
  try {
    accessToken = signOAuthJwt({
      sub: codeRow.address, // already lowercased
      cid: client.id,
      exp: Math.floor(Date.now() / 1000) + OAUTH_JWT_DEFAULT_TTL_SECONDS,
      scope: codeRow.scope || undefined
    });
  } catch (err) {
    if (err instanceof OAuthConfigError) {
      return NextResponse.json({ error: "server_error", reason: err.message }, { status: err.status });
    }
    throw err;
  }

  return NextResponse.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_JWT_DEFAULT_TTL_SECONDS,
    scope: codeRow.scope || undefined
  });
});
