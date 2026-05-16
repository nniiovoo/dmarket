-- Phase K.5a — Shop economy indexer tables.
--
-- Mirrors event streams from the four v3.3 shop-economy contracts
-- (ShopNFT, ShopShares, RevenueDistributor, ShareMarket) into a
-- read-optimised Postgres layout.
--
-- All five tables here are indexer-maintained: write paths live in
-- frontend/lib/indexer/v3_3/applyEvent*.ts. The Next.js app code reads
-- them via the /api/shops/* + /api/listings endpoints and MUST NOT
-- write directly — the indexer owns the cursor + state.
--
-- Apply:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts \
--     --file prisma/migrations/manual_v3_3_shop_economy.sql

-- ---------------------------------------------------------------------------
-- ShopNFT — one row per shopId, maintained by ShopNFT events
-- (ShopCreated / ShopMetadataUpdated / Transfer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ShopNFT" (
    "shopId"            INTEGER PRIMARY KEY,
    "currentOwner"      TEXT NOT NULL,
    "creator"           TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL,
    "name"              TEXT NOT NULL DEFAULT '',
    "description"       TEXT NOT NULL DEFAULT '',
    "imageUrl"          TEXT NOT NULL DEFAULT '',
    "lastUpdatedBlock"  BIGINT NOT NULL,
    "lastUpdatedTxHash" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "ShopNFT_currentOwner_idx" ON "ShopNFT" ("currentOwner");

-- ---------------------------------------------------------------------------
-- ShopShareHolding — current (shopId, holder) balance.
-- Rows with balance=0 are NOT deleted: holding history matters for
-- "addresses that have ever owned shares of shop N" queries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ShopShareHolding" (
    "shopId"           INTEGER NOT NULL,
    "holder"           TEXT NOT NULL,
    "balance"          TEXT NOT NULL,
    "lastUpdatedBlock" BIGINT NOT NULL,
    PRIMARY KEY ("shopId", "holder")
);
CREATE INDEX IF NOT EXISTS "ShopShareHolding_holder_idx" ON "ShopShareHolding" ("holder");
CREATE INDEX IF NOT EXISTS "ShopShareHolding_shopId_balance_idx"
    ON "ShopShareHolding" ("shopId", "balance");

-- ---------------------------------------------------------------------------
-- ShopRevenueEvent — union of the three RevenueDistributor event kinds.
-- eventType: 0 = Deposited, 1 = Settled, 2 = Claimed.
-- `holder` is null for Deposited events; the actor for Settled / Claimed.
-- token = 0x0 (NATIVE sentinel) when the revenue is the chain's native
-- asset, else an ERC-20 address.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ShopRevenueEvent" (
    "id"          TEXT PRIMARY KEY,
    "shopId"      INTEGER NOT NULL,
    "eventType"   INTEGER NOT NULL,
    "holder"      TEXT,
    "token"       TEXT NOT NULL,
    "amount"      TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash"      TEXT NOT NULL,
    "logIndex"    INTEGER NOT NULL DEFAULT 0,
    "blockTime"   TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ShopRevenueEvent_tx_log_uniq"
    ON "ShopRevenueEvent" ("txHash", "logIndex");
CREATE INDEX IF NOT EXISTS "ShopRevenueEvent_shopId_eventType_idx"
    ON "ShopRevenueEvent" ("shopId", "eventType");
CREATE INDEX IF NOT EXISTS "ShopRevenueEvent_holder_idx" ON "ShopRevenueEvent" ("holder");
CREATE INDEX IF NOT EXISTS "ShopRevenueEvent_block_idx" ON "ShopRevenueEvent" ("blockNumber");

-- ---------------------------------------------------------------------------
-- ShopListing — projection of ShareMarket events. Each listing has a
-- lifecycle: Active (0) → Filled (1) | Cancelled (2).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ShopListing" (
    "listingId"      INTEGER PRIMARY KEY,
    "seller"         TEXT NOT NULL,
    "shopId"         INTEGER NOT NULL,
    "amount"         TEXT NOT NULL,
    "paymentToken"   TEXT NOT NULL,
    "totalPrice"     TEXT NOT NULL,
    "status"         INTEGER NOT NULL,
    "buyer"          TEXT,
    "createdBlock"   BIGINT NOT NULL,
    "createdTxHash"  TEXT NOT NULL,
    "closedBlock"    BIGINT,
    "closedTxHash"   TEXT
);
CREATE INDEX IF NOT EXISTS "ShopListing_seller_idx" ON "ShopListing" ("seller");
CREATE INDEX IF NOT EXISTS "ShopListing_shopId_status_idx" ON "ShopListing" ("shopId", "status");
CREATE INDEX IF NOT EXISTS "ShopListing_status_idx" ON "ShopListing" ("status");

-- ---------------------------------------------------------------------------
-- IndexerStateV3_3ShopEconomy — per (chainId, contractAddress) cursor.
-- One row per contract: shopNft / shopShares / distributor / shareMarket
-- on Arbitrum Sepolia today. K.5b will add the v3.3 marketplace cursor
-- into a sibling table (or extend this one — TBD K.5b).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "IndexerStateV3_3ShopEconomy" (
    "chainId"          INTEGER NOT NULL,
    "contractAddress"  TEXT NOT NULL,
    "contractType"     TEXT NOT NULL,
    "lastIndexedBlock" BIGINT NOT NULL,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("chainId", "contractAddress")
);
CREATE INDEX IF NOT EXISTS "IndexerStateV3_3ShopEconomy_contractType_idx"
    ON "IndexerStateV3_3ShopEconomy" ("contractType");
