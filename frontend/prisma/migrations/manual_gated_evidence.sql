-- Manual migration for gated evidence storage.
--
-- WHY MANUAL: the existing prisma/migrations directory's migration_lock.toml
-- still says provider=sqlite while the active DATABASE_URL is postgres. That
-- mismatch makes `prisma migrate dev` refuse to run. Until you reconcile the
-- migration history (either reset it or update the lock + backfill postgres
-- migrations for past schema), apply this file by hand:
--
--   psql $DATABASE_URL -f frontend/prisma/migrations/manual_gated_evidence.sql
--
-- It is idempotent — re-running on a DB that already has these tables is a
-- no-op (IF NOT EXISTS guards everywhere).

CREATE TABLE IF NOT EXISTS "EvidenceUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "onChainOrderId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storageBackend" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "EvidenceUpload_chainId_onChainOrderId_idx"
    ON "EvidenceUpload"("chainId", "onChainOrderId");
CREATE INDEX IF NOT EXISTS "EvidenceUpload_contentHash_idx"
    ON "EvidenceUpload"("contentHash");
CREATE INDEX IF NOT EXISTS "EvidenceUpload_uploadedBy_idx"
    ON "EvidenceUpload"("uploadedBy");


CREATE TABLE IF NOT EXISTS "SiweNonce" (
    "nonce" TEXT NOT NULL PRIMARY KEY,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "SiweNonce_createdAt_idx"
    ON "SiweNonce"("createdAt");


CREATE TABLE IF NOT EXISTS "AuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AuthSession_address_idx"
    ON "AuthSession"("address");
CREATE INDEX IF NOT EXISTS "AuthSession_expiresAt_idx"
    ON "AuthSession"("expiresAt");
