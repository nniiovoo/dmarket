-- Manual migration to add V3.1 indexer tables.
--
-- WHY MANUAL: same reason as manual_gated_evidence.sql — the prisma
-- migration history's migration_lock.toml still says provider=sqlite while
-- the active DATABASE_URL is postgres, so `prisma migrate dev` refuses to
-- run.
--
-- Idempotent: every CREATE uses IF NOT EXISTS. Re-running on a DB that
-- already has these tables is a no-op.
--
-- Usage:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts --file prisma/migrations/manual_v3_1_indexer.sql

CREATE TABLE IF NOT EXISTS "OnChainOrderV3_1" (
    "id"                  SERIAL PRIMARY KEY,
    "chainId"             INTEGER       NOT NULL,
    "onChainOrderId"      TEXT          NOT NULL,
    "buyer"               TEXT          NOT NULL,
    "seller"              TEXT          NOT NULL,
    "productId"           TEXT          NOT NULL,
    "amountWei"           TEXT          NOT NULL,
    "status"              TEXT          NOT NULL,
    "createdAt"           TIMESTAMP(3),
    "paidAt"              TIMESTAMP(3),
    "shippedAt"           TIMESTAMP(3),
    "completedAt"         TIMESTAMP(3),
    "refundedAt"          TIMESTAMP(3),
    "disputedAt"          TIMESTAMP(3),
    "lastBlock"           BIGINT        NOT NULL,
    "lastLogIndex"        INTEGER       NOT NULL DEFAULT 0,
    "lastTxHash"          TEXT          NOT NULL,
    "lastSyncedAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "carrier"             TEXT,
    "trackingNumber"      TEXT,
    "trackingUrl"         TEXT,
    "shippingNote"        TEXT,
    "shippingUpdatedAt"   TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "OnChainOrderV3_1_chainId_onChainOrderId_key"
    ON "OnChainOrderV3_1"("chainId", "onChainOrderId");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_1_buyer_idx"
    ON "OnChainOrderV3_1"("buyer");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_1_seller_idx"
    ON "OnChainOrderV3_1"("seller");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_1_status_idx"
    ON "OnChainOrderV3_1"("status");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_1_chainId_idx"
    ON "OnChainOrderV3_1"("chainId");

CREATE TABLE IF NOT EXISTS "IndexerStateV3_1" (
    "chainId"   INTEGER       PRIMARY KEY,
    "lastBlock" BIGINT        NOT NULL,
    "updatedAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);
