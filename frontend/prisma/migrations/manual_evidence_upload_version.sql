-- Tags uploaded evidence rows with the marketplace version of the order they
-- belong to. V3 and V3.1 can reuse the same on-chain order ID on one chain,
-- so attachment authorization must key on all three dimensions.
--
-- Existing evidence predates V3.1 evidence uploads, so defaulting old rows to
-- v3 preserves their correct ownership.
--
-- Usage:
--   cd frontend
--   npx tsx scripts/applyManualMigration.ts --file prisma/migrations/manual_evidence_upload_version.sql

ALTER TABLE "EvidenceUpload"
  ADD COLUMN IF NOT EXISTS "marketplaceVersion" TEXT NOT NULL DEFAULT 'v3';

DROP INDEX IF EXISTS "EvidenceUpload_chainId_onChainOrderId_idx";

CREATE INDEX IF NOT EXISTS "EvidenceUpload_chainId_onChainOrderId_marketplaceVersion_idx"
  ON "EvidenceUpload" ("chainId", "onChainOrderId", "marketplaceVersion");
