-- Manual migration: Postgres full-text + trigram search on Product.
-- Phase I.1. The Product table doesn't carry a `category` column today,
-- so the searchVector is built from (name, description) only. If a
-- category column is ever added, regenerate the migration with weight C
-- including it.
--
-- Apply: npx tsx scripts/applyManualMigration.ts \
--   --file prisma/migrations/manual_product_search.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "Product"
    ADD COLUMN IF NOT EXISTS "searchVector" tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("name", '')),        'A') ||
        setweight(to_tsvector('english', coalesce("description", '')), 'B')
    ) STORED;

CREATE INDEX IF NOT EXISTS "Product_searchVector_idx"
    ON "Product" USING GIN ("searchVector");

CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx"
    ON "Product" USING GIN ("name" gin_trgm_ops);
