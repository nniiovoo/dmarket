// OAuth 2.0 Authorization Server Metadata (RFC 8414).
//
// ChatGPT's "Custom GPT with auth" form reads this document to discover
// endpoint URLs. Hosting it under /.well-known/ also makes the GPT Store
// review process straightforward — reviewers can hit one URL to see the
// whole config.

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? request.nextUrl.origin;
  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: ["ai.shop"]
  });
}
