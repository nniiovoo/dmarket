// Smoke test for blacklist integration in app/api/products/route.ts
// Run with: npx tsx scripts/smokeProductsBlacklist.ts
//
// Tests the exported pure helpers directly — no Next.js request types needed.

import { filterByBlacklist, blacklistGate } from "../app/api/products/route";

let passed = 0;

function assert(label: string, cond: unknown): void {
  if (!cond) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
  console.log(`PASS ${label}`);
  passed++;
}

// ── Fake products ─────────────────────────────────────────────────────────────

type FakeProduct = { sellerAddress: string; id: number; name: string };

const SELLER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SELLER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SELLER_C = "0xcccccccccccccccccccccccccccccccccccccccc";

function makeProduct(id: number, sellerAddress: string): FakeProduct {
  return { id, sellerAddress, name: `Product ${id}` };
}

// ── filterByBlacklist: empty blacklist ────────────────────────────────────────

{
  const products = [makeProduct(1, SELLER_A), makeProduct(2, SELLER_B)];
  const { filtered, total } = await filterByBlacklist(products, async () => ({ blacklisted: [] }));
  assert("GET: returns all products when blacklist empty", filtered.length === 2);
  assert("GET: total matches all when blacklist empty", total === 2);
}

// ── filterByBlacklist: filters out blacklisted seller ─────────────────────────

{
  const products = [makeProduct(1, SELLER_A), makeProduct(2, SELLER_B), makeProduct(3, SELLER_A)];
  const { filtered, total } = await filterByBlacklist(
    products,
    async () => ({ blacklisted: [SELLER_A] })
  );
  assert("GET: filters out blacklisted seller's products", filtered.length === 1);
  assert("GET: remaining product belongs to non-blacklisted seller", filtered[0].sellerAddress === SELLER_B);
  assert("GET: total matches filtered length (not original)", total === 1);
}

// ── filterByBlacklist: multiple sellers, correct filtering ────────────────────

{
  const products = [
    makeProduct(1, SELLER_A),
    makeProduct(2, SELLER_B),
    makeProduct(3, SELLER_C),
    makeProduct(4, SELLER_B),
  ];
  const { filtered, total } = await filterByBlacklist(
    products,
    async () => ({ blacklisted: [SELLER_A, SELLER_C] })
  );
  assert("GET: filters multiple sellers correctly", filtered.length === 2);
  assert("GET: total matches filtered length for multiple sellers", total === 2);
  assert("GET: only non-blacklisted seller remains", filtered.every((p) => p.sellerAddress === SELLER_B));
}

// ── filterByBlacklist: case-insensitive matching ──────────────────────────────

{
  const mixedCaseSeller = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const products = [makeProduct(1, mixedCaseSeller), makeProduct(2, SELLER_B)];
  // Blacklist stores lowercase as per isBlocked implementation
  const { filtered, total } = await filterByBlacklist(
    products,
    async () => ({ blacklisted: [SELLER_A] }) // lowercase version
  );
  assert("GET: case-insensitive — mixed-case seller matches lowercase blacklist entry", filtered.length === 1);
  assert("GET: case-insensitive total is post-filter", total === 1);
}

// ── blacklistGate: non-blocked seller passes ──────────────────────────────────

{
  const gate = await blacklistGate(SELLER_A, async () => false);
  assert("POST: succeeds (returns null) for non-blacklisted seller", gate === null);
}

// ── blacklistGate: blocked seller returns 403 ─────────────────────────────────

{
  const gate = await blacklistGate(SELLER_B, async () => true);
  assert("POST: returns 403 response for blacklisted seller", gate !== null && gate.status === 403);
}

// ── blacklistGate: 403 body checks ───────────────────────────────────────────

{
  const gate = await blacklistGate(SELLER_B, async () => true);
  const body = await gate!.json() as Record<string, string>;
  const bodyStr = JSON.stringify(body);

  assert("POST: 403 body has generic error message", body.error === "Seller is not permitted to list products");
  assert('POST: response body does not contain "blacklist"', !bodyStr.toLowerCase().includes("blacklist"));
  assert('POST: response body does not contain "blocked"', !bodyStr.toLowerCase().includes("blocked"));
  assert("POST: response body does not contain the seller address", !bodyStr.toLowerCase().includes(SELLER_B));
}

console.log(`\nALL PASS (${passed} assertions)`);
