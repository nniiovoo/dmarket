// Dual-auth for the AI ordering layer. A caller authenticates via either:
//
//   - SIWE session cookie (`chainus_session`) — used by our own Web chatbox
//     on chainus.org, where the user is already signed in.
//   - OAuth 2.0 bearer JWT (`Authorization: Bearer <jwt>`) — used by
//     external clients (ChatGPT Custom GPT, Claude MCP), issued by
//     /oauth/token after the user completes the SIWE landing on
//     /oauth/connect.
//
// Both paths resolve to the same artefact: a lowercased Ethereum address
// bound to this request. Downstream code never needs to know which auth
// mode produced it.
//
// JWTs are HS256-signed with OAUTH_JWT_SECRET (32+ bytes recommended).
// We don't take a dependency on `jose`/`jsonwebtoken`: HS256 is ~30 lines
// against node:crypto and skipping the package keeps Phase I.3 lean.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { Address } from "viem";
import type { NextRequest } from "next/server";

import { getSession } from "@/lib/auth/siwe";

export const OAUTH_JWT_ALG = "HS256";
export const OAUTH_JWT_DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
export const OAUTH_JWT_ISSUER = "chainus.org";
export const OAUTH_JWT_AUDIENCE = "chainus-ai";

export class OAuthConfigError extends Error {
  readonly status = 503;
}

function getJwtSecret(): Buffer {
  const raw = process.env.OAUTH_JWT_SECRET;
  if (!raw || raw.length < 16) {
    throw new OAuthConfigError(
      "OAUTH_JWT_SECRET is not set or too short (need ≥16 chars). Add it to .env before using OAuth flows."
    );
  }
  return Buffer.from(raw, "utf8");
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export interface OAuthJwtClaims {
  /// Lowercased 0x address — the wallet the caller is acting as.
  sub: string;
  /// OAuth client id (e.g. "chatgpt-shopping-gpt").
  cid: string;
  /// Issuer / audience: gate the token to this product.
  iss: string;
  aud: string;
  /// Issued-at and expiry in seconds since epoch (JWT standard).
  iat: number;
  exp: number;
  /// Optional space-separated scope string.
  scope?: string;
}

export function signOAuthJwt(claims: Omit<OAuthJwtClaims, "iss" | "aud" | "iat">): string {
  const secret = getJwtSecret();
  const header = { alg: OAUTH_JWT_ALG, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullClaims: OAuthJwtClaims = {
    iss: OAUTH_JWT_ISSUER,
    aud: OAUTH_JWT_AUDIENCE,
    iat: now,
    ...claims
  };
  const encodedHeader = b64urlEncode(Buffer.from(JSON.stringify(header)));
  const encodedPayload = b64urlEncode(Buffer.from(JSON.stringify(fullClaims)));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = b64urlEncode(createHmac("sha256", secret).update(data).digest());
  return `${data}.${signature}`;
}

export type VerifyJwtResult =
  | { ok: true; claims: OAuthJwtClaims }
  | { ok: false; reason: string };

export function verifyOAuthJwt(token: string): VerifyJwtResult {
  const secret = getJwtSecret();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_jwt" };
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlDecode(encodedHeader).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_header" };
  }
  if (header.alg !== OAUTH_JWT_ALG) return { ok: false, reason: "wrong_alg" };

  const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const provided = b64urlDecode(encodedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: OAuthJwtClaims;
  try {
    claims = JSON.parse(b64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }

  if (typeof claims.sub !== "string" || !/^0x[0-9a-f]{40}$/.test(claims.sub)) {
    return { ok: false, reason: "bad_subject" };
  }
  if (claims.iss !== OAUTH_JWT_ISSUER) return { ok: false, reason: "wrong_issuer" };
  if (claims.aud !== OAUTH_JWT_AUDIENCE) return { ok: false, reason: "wrong_audience" };
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}

export interface AuthedCaller {
  address: Address;
  /// How the caller authenticated. Useful for telemetry; downstream business
  /// logic should not branch on this.
  via: "siwe" | "oauth";
  /// Present only for OAuth callers.
  clientId?: string;
}

export type AuthRequireResult =
  | { ok: true; caller: AuthedCaller }
  | { ok: false; status: number; error: string; reason: string };

/// Resolves the caller from either a SIWE session cookie OR an OAuth
/// bearer JWT. Returns a structured failure (never throws) so route
/// handlers can short-circuit with a uniform 401/403 response.
export async function requireAuth(request: NextRequest): Promise<AuthRequireResult> {
  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    let result: VerifyJwtResult;
    try {
      result = verifyOAuthJwt(token);
    } catch (err) {
      if (err instanceof OAuthConfigError) {
        return { ok: false, status: 503, error: err.message, reason: "oauth_unconfigured" };
      }
      throw err;
    }
    if (!result.ok) {
      return { ok: false, status: 401, error: "Invalid bearer token", reason: result.reason };
    }
    return {
      ok: true,
      caller: {
        address: result.claims.sub as Address,
        via: "oauth",
        clientId: result.claims.cid
      }
    };
  }

  const session = await getSession();
  if (session) {
    return { ok: true, caller: { address: session.address, via: "siwe" } };
  }

  return { ok: false, status: 401, error: "Authentication required", reason: "no_credentials" };
}
