-- Per-user, per-thread "last seen" cursor for inbox unread counts.
-- One row per (walletAddress, chainId, onChainOrderId, marketplaceVersion).
-- The chat GET endpoint upserts lastSeenAt whenever the user fetches a
-- thread, so opening the order detail page marks the thread as read.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--
-- Usage:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts --file prisma/migrations/manual_order_chat_last_seen.sql

CREATE TABLE IF NOT EXISTS "OrderChatLastSeen" (
    "walletAddress"      TEXT         NOT NULL,
    "chainId"            INTEGER      NOT NULL,
    "onChainOrderId"     TEXT         NOT NULL,
    "marketplaceVersion" TEXT         NOT NULL DEFAULT 'v3',
    "lastSeenAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("walletAddress", "chainId", "onChainOrderId", "marketplaceVersion")
);

-- Lets /api/inbox cheaply enumerate "what threads has this wallet seen
-- recently" — useful for future sort-by-last-seen and for finding stale
-- cursors during cleanup.
CREATE INDEX IF NOT EXISTS "OrderChatLastSeen_walletAddress_lastSeenAt_idx"
    ON "OrderChatLastSeen" ("walletAddress", "lastSeenAt");
