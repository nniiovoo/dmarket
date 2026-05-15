-- Manual migration: PublishedAttestation + ReputationRefreshQueue.
-- See frontend/prisma/schema.prisma for the typed models.
-- Apply with: npx tsx scripts/applyManualMigration.ts \
--   --file prisma/migrations/manual_published_attestation.sql

CREATE TABLE IF NOT EXISTS "PublishedAttestation" (
    "id"            TEXT NOT NULL,
    "subject"       TEXT NOT NULL,
    "score"         INTEGER NOT NULL,
    "issuedAt"      TIMESTAMP(3) NOT NULL,
    "expiry"        TIMESTAMP(3) NOT NULL,
    "version"       INTEGER NOT NULL,
    "signature"     TEXT NOT NULL,
    "chainId"       INTEGER NOT NULL,
    "registryAddr"  TEXT NOT NULL,
    "txHash"        TEXT,
    "publishedAt"   TIMESTAMP(3),
    CONSTRAINT "PublishedAttestation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PublishedAttestation_subject_version_key"
    ON "PublishedAttestation"("subject", "version");

CREATE INDEX IF NOT EXISTS "PublishedAttestation_subject_idx"
    ON "PublishedAttestation"("subject");

CREATE TABLE IF NOT EXISTS "ReputationRefreshQueue" (
    "subject"     TEXT NOT NULL,
    "queuedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "ReputationRefreshQueue_pkey" PRIMARY KEY ("subject")
);

CREATE INDEX IF NOT EXISTS "ReputationRefreshQueue_processedAt_idx"
    ON "ReputationRefreshQueue"("processedAt");
