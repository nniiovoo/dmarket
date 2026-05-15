-- Manual migration: V3.2 marketplace indexer tables.
-- See frontend/prisma/schema.prisma OnChainOrderV3_2 + IndexerStateV3_2.
-- Applied via: npx tsx scripts/applyManualMigration.ts \
--   --file prisma/migrations/manual_onchain_order_v3_2.sql

CREATE TABLE IF NOT EXISTS "OnChainOrderV3_2" (
    "id"                 TEXT NOT NULL,
    "chainId"            INTEGER NOT NULL,
    "marketplaceAddress" TEXT NOT NULL,
    "onChainOrderId"     TEXT NOT NULL,
    "buyer"              TEXT NOT NULL,
    "seller"             TEXT NOT NULL,
    "paymentToken"       TEXT NOT NULL,
    "productId"          TEXT NOT NULL,
    "amount"             TEXT NOT NULL,
    "status"             INTEGER NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL,
    "paidAt"             TIMESTAMP(3),
    "shippedAt"          TIMESTAMP(3),
    "completedAt"        TIMESTAMP(3),
    "disputedAt"         TIMESTAMP(3),
    "lastEventBlock"     BIGINT NOT NULL,
    "lastEventTxHash"    TEXT NOT NULL,
    "lastSyncedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnChainOrderV3_2_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OnChainOrderV3_2_chainId_marketplaceAddress_onChainOrderId_key"
    ON "OnChainOrderV3_2"("chainId", "marketplaceAddress", "onChainOrderId");

CREATE INDEX IF NOT EXISTS "OnChainOrderV3_2_buyer_idx" ON "OnChainOrderV3_2"("buyer");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_2_seller_idx" ON "OnChainOrderV3_2"("seller");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_2_chainId_marketplaceAddress_idx"
    ON "OnChainOrderV3_2"("chainId", "marketplaceAddress");

CREATE TABLE IF NOT EXISTS "IndexerStateV3_2" (
    "chainId"            INTEGER NOT NULL,
    "marketplaceAddress" TEXT NOT NULL,
    "lastBlock"          BIGINT NOT NULL,
    "lastLogIndex"       INTEGER NOT NULL DEFAULT -1,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IndexerStateV3_2_pkey" PRIMARY KEY ("chainId", "marketplaceAddress")
);
