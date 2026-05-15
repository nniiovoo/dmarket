// POST /api/oauth/grant
//
// Called by the /oauth/connect page after SIWE succeeds. Re-validates the
// OAuth params, mints a one-time authorization code bound to
// (clientId, address, redirectUri, PKCE), and returns the redirect URL the
// browser should navigate to. The browser-driven redirect (rather than a
// server-side 302 here) keeps the SIWE session cookie attached for any
// follow-up navigation back into our own app.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { getSession } from "@/lib/auth/siwe";
import { findClient, isAllowedRedirect } from "@/lib/ai/oauthClients";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const AUTH_CODE_TTL_SECONDS = 5 * 60; // 5 minutes; OAuth 2.1 recommends ≤10.

const bodySchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  state: z.string().optional(),
  scope: z.string().optional(),
  codeChallenge: z.string().optional(),
  codeChallengeMethod: z.enum(["S256", "plain"]).optional()
});

export const POST = withErrorBoundary(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "siwe_required", reason: "no_session" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", reason: "bad_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { clientId, redirectUri, state, scope, codeChallenge, codeChallengeMethod } = parsed.data;

  const client = findClient(clientId);
  if (!client) {
    return NextResponse.json({ error: "invalid_client", reason: "unknown_client_id" }, { status: 400 });
  }
  if (!isAllowedRedirect(client, redirectUri)) {
    return NextResponse.json(
      { error: "invalid_request", reason: "redirect_uri_not_allowed" },
      { status: 400 }
    );
  }
  if (codeChallenge && !codeChallengeMethod) {
    return NextResponse.json(
      { error: "invalid_request", reason: "code_challenge_without_method" },
      { status: 400 }
    );
  }

  const code = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000);

  await prisma.oAuthAuthorizationCode.create({
    data: {
      code,
      clientId,
      address: session.address.toLowerCase(),
      redirectUri,
      scope: scope ?? "",
      codeChallenge: codeChallenge ?? null,
      codeChallengeMethod: codeChallengeMethod ?? null,
      expiresAt
    }
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

  return NextResponse.json({ redirectUrl: redirect.toString() });
});
