// Applies a manual SQL migration via Prisma's connection. Replacement for
// `psql ... -f migration.sql` when you don't have the psql CLI installed
// locally.
//
// Idempotent — the SQL files use CREATE TABLE IF NOT EXISTS / CREATE INDEX
// IF NOT EXISTS, so re-running is a no-op.
//
// Usage:
//   cd frontend
//   npx tsx scripts/applyManualMigration.ts                              # default: manual_gated_evidence.sql
//   npx tsx scripts/applyManualMigration.ts --file prisma/migrations/manual_v3_1_indexer.sql

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

const DEFAULT_MIGRATION_FILE = "prisma/migrations/manual_gated_evidence.sql";

function parseMigrationPath(): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") {
      const next = argv[i + 1];
      if (!next) throw new Error("--file requires a path argument");
      return next;
    }
    if (argv[i]?.startsWith("--file=")) {
      return argv[i]!.slice("--file=".length);
    }
  }
  return DEFAULT_MIGRATION_FILE;
}

async function main() {
  const migrationFile = parseMigrationPath();
  const path = join(process.cwd(), migrationFile);
  console.log(`Reading ${path}`);
  const sql = readFileSync(path, "utf8");

  // Strip line comments first so we don't accidentally drop a CREATE that
  // happens to follow a comment block in the same chunk after the split.
  const stripped = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  // Split on semicolons that terminate statements. Our SQL has no embedded
  // semicolons inside strings, so this naive split is safe here.
  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Found ${statements.length} statement(s) to execute.\n`);

  const prisma = new PrismaClient();

  try {
    let ok = 0;
    for (const stmt of statements) {
      const summary = stmt.split("\n")[0]?.slice(0, 80) ?? stmt.slice(0, 80);
      process.stdout.write(`  ${summary} … `);
      try {
        await prisma.$executeRawUnsafe(stmt);
        process.stdout.write("✓\n");
        ok += 1;
      } catch (err) {
        process.stdout.write("✗\n");
        const message = err instanceof Error ? err.message : String(err);
        // CREATE TABLE IF NOT EXISTS still throws on some Postgres versions
        // for some object types — accept "already exists" as success.
        if (message.toLowerCase().includes("already exists")) {
          console.log("    (already exists — ignored)");
          ok += 1;
        } else {
          throw err;
        }
      }
    }
    console.log(`\n✓ ${ok}/${statements.length} statements applied.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("\n✗ Migration failed:");
  console.error(err);
  process.exitCode = 1;
});
