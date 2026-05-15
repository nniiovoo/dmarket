// OAuth 2.0 authorization endpoint (Phase I.3).
//
// GET /oauth/authorize?client_id=&redirect_uri=&response_type=code
//                     &state=&scope=&code_challenge=&code_challenge_method=
//
// The endpoint validates the *params* (client + redirect allowlist) and
// forwards the user to /oauth/connect with the same params intact. The
// landing page handles SIWE; once the user is authenticated it POSTs to
// /api/oauth/grant to mint the actual authorization code.
//
// Failures here render JSON because they're typically a misconfigured
// client — sending the user to a broken connect page would be confusing.

import { NextRequest, NextResponse } from "next/server";

import { findClient, isAllowedRedirect } from "@/lib/ai/oauthClients";

export const dynamic = "force-dynamic";

const REQUIRED_RESPONSE_TYPE = "code";

export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const responseType = params.get("response_type");

  if (!clientId) {
    return NextResponse.json({ error: "invalid_request", reason: "missing_client_id" }, { status: 400 });
  }
  if (!redirectUri) {
    return NextResponse.json({ error: "invalid_request", reason: "missing_redirect_uri" }, { status: 400 });
  }
  if (responseType !== REQUIRED_RESPONSE_TYPE) {
    return NextResponse.json(
      { error: "unsupported_response_type", reason: `must be "${REQUIRED_RESPONSE_TYPE}"` },
      { status: 400 }
    );
  }

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

  // Pass everything through to the SIWE landing page. The landing page
  // re-validates server-side before issuing a code.
  const connectUrl = new URL("/oauth/connect", request.nextUrl.origin);
  for (const [k, v] of params.entries()) connectUrl.searchParams.set(k, v);
  return NextResponse.redirect(connectUrl);
}
