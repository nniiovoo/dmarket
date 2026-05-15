-- Phase I.3 — public AI API: OAuth code-exchange + DraftOrder sign-URL flow.
--
-- DraftOrder
--   Stores an *unsigned* EIP-712 PaymentAuth payload prepared by
--   /api/ai/draft-order. The buyer is the address bound to the caller's
--   session/OAuth token; the row is short-lived (30 min default) and is
--   marked signedAt once the buyer's wallet posts the signature via
--   /sign/[id]. We keep the txHash for audit but the marketplace tx itself
--   is on-chain — this row is purely the "queue between agent and wallet".
--
-- OAuthAuthorizationCode
--   Short-lived (5 min) one-time codes for OAuth 2.0 authorization-code
--   flow. After the user signs SIWE on /oauth/connect, we generate a code
--   bound to the (clientId, address, redirectUri) and redirect back to
--   the client. Client POSTs to /oauth/token to exchange the code for a
--   JWT bearer (no refresh tokens in MVP — buyers can re-authorize when
--   the JWT expires).
--
-- Tokens themselves are stateless JWTs signed with OAUTH_JWT_SECRET, so
-- no separate token table.
--
-- Apply:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts \
--     --file prisma/migrations/manual_ai_oauth_draft_order.sql

CREATE TABLE IF NOT EXISTS "DraftOrder" (
    "id"                  TEXT PRIMARY KEY,
    "buyer"               TEXT NOT NULL,
    "seller"              TEXT NOT NULL,
    "paymentToken"        TEXT NOT NULL,
    "productId"           TEXT NOT NULL,
    "amount"              TEXT NOT NULL,
    "nonce"               TEXT NOT NULL,
    "deadline"            TIMESTAMPTZ NOT NULL,
    "chainId"             INTEGER NOT NULL,
    "marketplaceAddress"  TEXT NOT NULL,
    "productNameSnapshot" TEXT NOT NULL DEFAULT '',
    "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt"           TIMESTAMPTZ NOT NULL,
    "signedAt"            TIMESTAMPTZ,
    "txHash"              TEXT,
    "cancelledAt"         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "DraftOrder_buyer_createdAt_idx"
    ON "DraftOrder" ("buyer", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "DraftOrder_expiresAt_idx"
    ON "DraftOrder" ("expiresAt");

CREATE TABLE IF NOT EXISTS "OAuthAuthorizationCode" (
    "code"                TEXT PRIMARY KEY,
    "clientId"            TEXT NOT NULL,
    "address"             TEXT NOT NULL,
    "redirectUri"         TEXT NOT NULL,
    "scope"               TEXT NOT NULL DEFAULT '',
    "codeChallenge"       TEXT,
    "codeChallengeMethod" TEXT,
    "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt"           TIMESTAMPTZ NOT NULL,
    "consumedAt"          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "OAuthAuthorizationCode_expiresAt_idx"
    ON "OAuthAuthorizationCode" ("expiresAt");

CREATE INDEX IF NOT EXISTS "OAuthAuthorizationCode_address_idx"
    ON "OAuthAuthorizationCode" ("address");
