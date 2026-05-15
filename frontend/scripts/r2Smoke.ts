// Cloudflare R2 connectivity smoke test.
//
// Verifies the four R2_* env vars resolve to a working bucket the credentials
// can read + write. Round-trips a single test object — uploads ~100 bytes,
// reads it back, confirms byte-for-byte equality, then HEADs to confirm
// exists() returns true.
//
// Usage:
//   cd frontend
//   STORAGE_BACKEND=r2 \
//   R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
//   R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... \
//   R2_BUCKET=chainus-evidence \
//     npx tsx scripts/r2Smoke.ts
//
// Or after putting the vars in frontend/.env.local:
//   npx tsx scripts/r2Smoke.ts

// Load .env.local first so it wins over .env (mirrors Next.js behavior).
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });

import { randomBytes } from "node:crypto";

import { getStorage } from "../lib/storage";

async function main() {
  const backend = process.env.STORAGE_BACKEND ?? "(unset)";
  console.log(`STORAGE_BACKEND=${backend}`);

  if (backend !== "r2") {
    console.log("\nThis script only makes sense with STORAGE_BACKEND=r2.");
    console.log("Re-run with STORAGE_BACKEND=r2 in your env or .env.local.");
    process.exit(1);
  }

  const storage = getStorage();
  console.log(`backend.adapter = ${storage.backend}`);

  const testKey = `__smoke__/${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
  const testBytes = Buffer.from(
    `R2 smoke test from ChainUs. ts=${new Date().toISOString()}\n`
  );
  console.log(`\nPUT  ${testKey} (${testBytes.length} bytes)`);

  const start = Date.now();
  const stored = await storage.put(testKey, testBytes, "text/plain");
  console.log(`     ✓ ${Date.now() - start}ms  contentHash=${stored.contentHash}`);

  console.log(`HEAD ${testKey}`);
  const exists = await storage.exists(testKey);
  console.log(`     ✓ exists=${exists}`);
  if (!exists) {
    console.error("\n✗ FAILED: HEAD returned false right after PUT.");
    process.exit(1);
  }

  console.log(`GET  ${testKey}`);
  const fetched = await storage.get(testKey);
  console.log(`     ✓ ${fetched.length} bytes returned`);
  if (!fetched.equals(testBytes)) {
    console.error("\n✗ FAILED: round-tripped bytes do not match.");
    console.error("Expected:", testBytes.toString());
    console.error("Got:    ", fetched.toString());
    process.exit(1);
  }
  console.log("     ✓ bytes match exactly");

  console.log("\n✓ R2 connectivity OK. You can switch evidence uploads to R2 in prod.");
  console.log(
    `  Note: the test object ${testKey} was NOT deleted (no delete in StorageAdapter API).\n` +
      `  Delete it manually from the Cloudflare R2 dashboard if you want a clean bucket.`
  );
}

main().catch((err: unknown) => {
  console.error("\n✗ R2 smoke test failed:");
  console.error(err);
  process.exitCode = 1;
});
