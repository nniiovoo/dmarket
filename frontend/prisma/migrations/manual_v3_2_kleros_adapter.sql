-- Manual migration: v3.2 Kleros adapter mirror columns + cursor table.
-- Phase H.3. See contracts/v3_2/KlerosV2DisputeAdapterV3_2.sol for the
-- events whose state is mirrored here.
-- Apply with: npx tsx scripts/applyManualMigration.ts \
--   --file prisma/migrations/manual_v3_2_kleros_adapter.sql

ALTER TABLE "OnChainOrderV3_2"
    ADD COLUMN IF NOT EXISTS "klerosDisputeId"     TEXT;

ALTER TABLE "OnChainOrderV3_2"
    ADD COLUMN IF NOT EXISTS "disputeEscalatedAt"  TIMESTAMP(3);

ALTER TABLE "OnChainOrderV3_2"
    ADD COLUMN IF NOT EXISTS "klerosRuling"        INTEGER;

ALTER TABLE "OnChainOrderV3_2"
    ADD COLUMN IF NOT EXISTS "klerosRuledAt"       TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "OnChainOrderV3_2_klerosDisputeId_idx"
    ON "OnChainOrderV3_2"("klerosDisputeId");

CREATE TABLE IF NOT EXISTS "IndexerStateV3_2KlerosAdapter" (
    "chainId"          INTEGER NOT NULL,
    "adapterAddress"   TEXT NOT NULL,
    "lastIndexedBlock" BIGINT NOT NULL,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IndexerStateV3_2KlerosAdapter_pkey" PRIMARY KEY ("chainId", "adapterAddress")
);
