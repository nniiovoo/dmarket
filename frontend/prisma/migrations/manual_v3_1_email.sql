-- Adds marketplaceVersion to EmailLog so V3 and V3.1 share the table
-- without colliding on the 24h dedup key (chainId + kind + onChainOrderId).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP INDEX IF EXISTS +
-- CREATE INDEX IF NOT EXISTS.
--
-- Usage:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts --file prisma/migrations/manual_v3_1_email.sql

ALTER TABLE "EmailLog"
  ADD COLUMN IF NOT EXISTS "marketplaceVersion" TEXT NOT NULL DEFAULT 'v3';

-- Drop the old narrower index (it doesn't include the new column, so the
-- dedup query in sendToEmail() can no longer use it efficiently).
DROP INDEX IF EXISTS "EmailLog_toAddress_kind_onChainOrderId_idx";

-- New composite index that matches the exact shape of the dedup WHERE
-- clause: toAddress + kind + chainId + onChainOrderId + marketplaceVersion.
CREATE INDEX IF NOT EXISTS "EmailLog_dedup_idx"
  ON "EmailLog" ("toAddress", "kind", "chainId", "onChainOrderId", "marketplaceVersion");
