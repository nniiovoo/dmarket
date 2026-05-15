-- Unified-messenger refactor. Adds the Conversation /
-- ConversationMessage / ConversationLastSeen tables that replace the
-- per-order OrderChatMessage surface in the UI. Old tables are kept in
-- place (their rows are deprecated but readable for audit).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
--
-- Usage:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts --file prisma/migrations/manual_conversations.sql

CREATE TABLE IF NOT EXISTS "Conversation" (
    "id"               TEXT         PRIMARY KEY,
    "chainId"          INTEGER      NOT NULL,
    "participantA"     TEXT         NOT NULL,
    "participantB"     TEXT         NOT NULL,
    "initialProductId" TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_chainId_participantA_participantB_key"
    ON "Conversation" ("chainId", "participantA", "participantB");

CREATE INDEX IF NOT EXISTS "Conversation_participantA_lastMessageAt_idx"
    ON "Conversation" ("participantA", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "Conversation_participantB_lastMessageAt_idx"
    ON "Conversation" ("participantB", "lastMessageAt");

CREATE TABLE IF NOT EXISTS "ConversationMessage" (
    "id"                    TEXT         PRIMARY KEY,
    "conversationId"        TEXT         NOT NULL,
    "senderAddress"         TEXT         NOT NULL,
    "body"                  TEXT         NOT NULL,
    "attachmentKey"         TEXT,
    "attachmentBackend"     TEXT,
    "attachmentContentType" TEXT,
    "attachmentFileName"    TEXT,
    "attachmentSize"        INTEGER,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationMessage_conversationId_fkey"
        FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ConversationMessage_conversationId_createdAt_idx"
    ON "ConversationMessage" ("conversationId", "createdAt");

CREATE INDEX IF NOT EXISTS "ConversationMessage_senderAddress_idx"
    ON "ConversationMessage" ("senderAddress");

CREATE TABLE IF NOT EXISTS "ConversationLastSeen" (
    "walletAddress"  TEXT         NOT NULL,
    "conversationId" TEXT         NOT NULL,
    "lastSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("walletAddress", "conversationId")
);

CREATE INDEX IF NOT EXISTS "ConversationLastSeen_walletAddress_lastSeenAt_idx"
    ON "ConversationLastSeen" ("walletAddress", "lastSeenAt");
