-- Per-order buyer/seller chat. Adds a single table + two supporting
-- indexes. Migration is idempotent (CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS), so re-running is a no-op.
--
-- WHY MANUAL: same reason as manual_v3_1_indexer.sql — prisma's
-- migration_lock.toml still says provider=sqlite while the active
-- DATABASE_URL is postgres, so `prisma migrate dev` refuses to run.
--
-- Usage:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts --file prisma/migrations/manual_order_chat.sql

CREATE TABLE IF NOT EXISTS "OrderChatMessage" (
    "id"                  TEXT         PRIMARY KEY,
    "chainId"             INTEGER      NOT NULL,
    "onChainOrderId"      TEXT         NOT NULL,
    "marketplaceVersion"  TEXT         NOT NULL DEFAULT 'v3',
    "senderAddress"       TEXT         NOT NULL,
    "body"                TEXT         NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Matches the shape of the chat-list GET query:
-- WHERE chainId=? AND onChainOrderId=? AND marketplaceVersion=? AND createdAt > ?
-- ORDER BY createdAt ASC.
CREATE INDEX IF NOT EXISTS "OrderChatMessage_thread_idx"
    ON "OrderChatMessage" ("chainId", "onChainOrderId", "marketplaceVersion", "createdAt");

-- Lets us cheaply enumerate everything a wallet has sent — useful for the
-- per-wallet rate-limit fallback if we ever move it from in-memory to DB,
-- and for "show me my message history" admin views down the road.
CREATE INDEX IF NOT EXISTS "OrderChatMessage_senderAddress_idx"
    ON "OrderChatMessage" ("senderAddress");
