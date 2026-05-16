-- Phase K.5b — v3.3 marketplace order projection.
--
-- Mirrors OnChainOrderV3_2's shape plus the v3.3-specific `shopId`
-- snapshot (set at create time, immutable for the order's lifetime —
-- see EscrowMarketplaceV3_3 "investor invariant" in the header) and
-- the fee/sellerAmount split written by RevenueDistributed events on
-- order completion.
--
-- Cursor is NOT a new table — the K.5a IndexerStateV3_3ShopEconomy
-- table already exists and is keyed on (chainId, contractAddress).
-- We just add a 5th row with contractType='marketplace'.
--
-- Apply:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts \
--     --file prisma/migrations/manual_v3_3_marketplace.sql

CREATE TABLE IF NOT EXISTS "OnChainOrderV3_3" (
    "chainId"            INTEGER NOT NULL,
    "marketplaceAddress" TEXT NOT NULL,
    "onChainOrderId"     TEXT NOT NULL,
    "buyer"              TEXT NOT NULL,
    "seller"             TEXT NOT NULL,
    "shopId"             INTEGER NOT NULL,
    "paymentToken"       TEXT NOT NULL,
    "productId"          TEXT NOT NULL,
    "amount"             TEXT NOT NULL,
    "status"             INTEGER NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL,
    "paidAt"             TIMESTAMP(3),
    "shippedAt"          TIMESTAMP(3),
    "completedAt"        TIMESTAMP(3),
    "disputedAt"         TIMESTAMP(3),
    "feeAmount"          TEXT,
    "sellerAmount"       TEXT,
    "lastEventBlock"     BIGINT NOT NULL,
    "lastEventTxHash"    TEXT NOT NULL,
    "lastSyncedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("chainId", "marketplaceAddress", "onChainOrderId")
);
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_3_buyer_idx" ON "OnChainOrderV3_3" ("buyer");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_3_seller_idx" ON "OnChainOrderV3_3" ("seller");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_3_shopId_idx" ON "OnChainOrderV3_3" ("shopId");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_3_status_idx" ON "OnChainOrderV3_3" ("status");
CREATE INDEX IF NOT EXISTS "OnChainOrderV3_3_chainId_marketplace_idx"
    ON "OnChainOrderV3_3" ("chainId", "marketplaceAddress");
