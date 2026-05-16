-- Manual migration: ShopListing now tracks partial-fill state.
-- Phase M.1. The pre-M.1 ShareMarket (K.4) had a single `amount` +
-- `totalPrice`; M.1 splits this into:
--   - originalAmount  — listing size at create time (immutable)
--   - remainingAmount — unfilled balance (monotonically decreases)
--   - pricePerToken   — unit price for new partial-fill events
--
-- Legacy K.4 listings stay in the table with `originalAmount` /
-- `remainingAmount` / `pricePerToken` = NULL; the indexer / API
-- continue to read `amount` + `totalPrice` for those rows. New M.1
-- listings always populate all three new fields, and also keep the
-- legacy `amount` + `totalPrice` columns set so any UI that hasn't
-- been migrated yet still renders something useful.
--
-- Apply with:
--   npx tsx scripts/applyManualMigration.ts \
--     --file prisma/migrations/manual_share_market_partial_fill.sql

ALTER TABLE "ShopListing"
    ADD COLUMN IF NOT EXISTS "originalAmount"  TEXT;

ALTER TABLE "ShopListing"
    ADD COLUMN IF NOT EXISTS "remainingAmount" TEXT;

ALTER TABLE "ShopListing"
    ADD COLUMN IF NOT EXISTS "pricePerToken"   TEXT;
