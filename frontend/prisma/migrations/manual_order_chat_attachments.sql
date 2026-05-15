-- Adds 5 nullable attachment columns to OrderChatMessage. Existing
-- text-only rows are untouched; the chat panel renders an image
-- thumbnail only when attachmentKey IS NOT NULL.
--
-- Idempotent: every column add uses IF NOT EXISTS. Re-running is a no-op.
--
-- Usage:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts --file prisma/migrations/manual_order_chat_attachments.sql

ALTER TABLE "OrderChatMessage"
  ADD COLUMN IF NOT EXISTS "attachmentKey"         TEXT;
ALTER TABLE "OrderChatMessage"
  ADD COLUMN IF NOT EXISTS "attachmentBackend"     TEXT;
ALTER TABLE "OrderChatMessage"
  ADD COLUMN IF NOT EXISTS "attachmentContentType" TEXT;
ALTER TABLE "OrderChatMessage"
  ADD COLUMN IF NOT EXISTS "attachmentFileName"    TEXT;
ALTER TABLE "OrderChatMessage"
  ADD COLUMN IF NOT EXISTS "attachmentSize"        INTEGER;
