-- Manual migration: v3.3 Kleros adapter mirror columns on OnChainOrderV3_3.
-- Phase L.3. Mirrors the v3.2 schema (manual_v3_2_kleros_adapter.sql) so the
-- API + frontend can render the same {disputeId, ruling, timestamps} shape
-- regardless of marketplace version.
--
-- Cursor reuses IndexerStateV3_3ShopEconomy (Phase K.5a) with contractType
-- = 'klerosAdapter' — no new cursor table needed.
--
-- Apply with: npx tsx scripts/applyManualMigration.ts \
--   --file prisma/migrations/manual_v3_3_kleros_adapter.sql

ALTER TABLE "OnChainOrderV3_3"
    ADD COLUMN IF NOT EXISTS "klerosDisputeId"     TEXT;

ALTER TABLE "OnChainOrderV3_3"
    ADD COLUMN IF NOT EXISTS "disputeEscalatedAt"  TIMESTAMP(3);

ALTER TABLE "OnChainOrderV3_3"
    ADD COLUMN IF NOT EXISTS "klerosRuling"        INTEGER;

ALTER TABLE "OnChainOrderV3_3"
    ADD COLUMN IF NOT EXISTS "klerosRuledAt"       TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "OnChainOrderV3_3_klerosDisputeId_idx"
    ON "OnChainOrderV3_3"("klerosDisputeId");
