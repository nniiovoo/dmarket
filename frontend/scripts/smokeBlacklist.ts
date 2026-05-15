// Smoke test for lib/blacklist.ts + lib/risk/integrations/blacklist.ts
// Run with: npx tsx scripts/smokeBlacklist.ts
//
// Uses dependency-injected fake DB — no real Prisma/Postgres required.

import {
  addEntry,
  BlacklistDuplicateError,
  isBlocked,
  listAll,
  removeEntry,
  type BlacklistEntry,
} from "../lib/blacklist";

let passed = 0;

function assert(label: string, cond: unknown): void {
  if (!cond) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
  console.log(`PASS ${label}`);
  passed++;
}

// ── In-memory fake store ──────────────────────────────────────────────────────

type Row = BlacklistEntry;
const store = new Map<string, Row>();
let nextId = 1;

const fakeDb = {
  blacklist: {
    findUnique: ({ where }: { where: { address: string } }) =>
      Promise.resolve(store.get(where.address) ?? null),
    create: ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
      const row: Row = { id: nextId++, ...data, createdAt: new Date() };
      store.set(row.address, row);
      return Promise.resolve(row);
    },
    deleteMany: ({ where }: { where: { address: string } }) => {
      const existed = store.has(where.address);
      store.delete(where.address);
      return Promise.resolve({ count: existed ? 1 : 0 });
    },
    findMany: ({ orderBy }: { orderBy: { createdAt: "asc" | "desc" } }) => {
      const rows = Array.from(store.values());
      rows.sort((a, b) =>
        orderBy.createdAt === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime()
      );
      return Promise.resolve(rows);
    },
  },
};

// Helper to test loadBlacklistFacts using the same fake DB.
async function loadBlacklistFacts(addresses: string[]): Promise<{ blacklisted: string[] }> {
  const results = await Promise.all(
    addresses.map(async (addr) => ({ addr, blocked: await isBlocked(addr, fakeDb) }))
  );
  return { blacklisted: results.filter((r) => r.blocked).map((r) => r.addr) };
}

// ── isBlocked: false for unknown address ─────────────────────────────────────

assert(
  "isBlocked returns false for unknown",
  !(await isBlocked("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", fakeDb))
);

// ── addEntry: rejects invalid address ────────────────────────────────────────

let threw = false;
try {
  await addEntry({ address: "not-an-address", reason: "test", addedBy: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, fakeDb);
} catch {
  threw = true;
}
assert("addEntry rejects invalid address", threw);

// ── addEntry: rejects empty reason ───────────────────────────────────────────

threw = false;
try {
  await addEntry({ address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", reason: "   ", addedBy: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, fakeDb);
} catch {
  threw = true;
}
assert("addEntry rejects empty reason", threw);

// ── addEntry: normalises mixed-case input ────────────────────────────────────

const entry = await addEntry(
  {
    address: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    reason: "fraud",
    addedBy: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  fakeDb
);
assert("addEntry stores lowercase address", entry.address === "0xcccccccccccccccccccccccccccccccccccccccc");

// ── isBlocked: true after add, mixed-case lookup ─────────────────────────────

assert("isBlocked true after add (exact lower)", await isBlocked("0xcccccccccccccccccccccccccccccccccccccccc", fakeDb));
assert("isBlocked true with mixed-case input", await isBlocked("0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", fakeDb));

// ── addEntry: BlacklistDuplicateError on duplicate ───────────────────────────

let dupErr: unknown;
try {
  await addEntry({ address: "0xcccccccccccccccccccccccccccccccccccccccc", reason: "again", addedBy: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, fakeDb);
} catch (e) {
  dupErr = e;
}
assert("addEntry throws BlacklistDuplicateError on duplicate", dupErr instanceof BlacklistDuplicateError);

// ── removeEntry: returns false for non-existent ──────────────────────────────

assert("removeEntry false for non-existent", !(await removeEntry("0xdddddddddddddddddddddddddddddddddddddddd", fakeDb)));

// ── removeEntry: returns true for existing, then isBlocked false ─────────────

assert("removeEntry true for existing", await removeEntry("0xcccccccccccccccccccccccccccccccccccccccc", fakeDb));
assert("isBlocked false after remove", !(await isBlocked("0xcccccccccccccccccccccccccccccccccccccccc", fakeDb)));

// ── listAll: returns entries sorted by createdAt asc ─────────────────────────

await addEntry({ address: "0x1111111111111111111111111111111111111111", reason: "r1", addedBy: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, fakeDb);
await addEntry({ address: "0x2222222222222222222222222222222222222222", reason: "r2", addedBy: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, fakeDb);
const all = await listAll(fakeDb);
assert("listAll returns all entries", all.length === 2);
assert("listAll sorted asc by createdAt", all[0].address === "0x1111111111111111111111111111111111111111");

// ── loadBlacklistFacts: returns only blacklisted subset ─────────────────────

const facts = await loadBlacklistFacts([
  "0x1111111111111111111111111111111111111111",
  "0x9999999999999999999999999999999999999999",
  "0x2222222222222222222222222222222222222222",
]);
assert("loadBlacklistFacts blacklisted count correct", facts.blacklisted.length === 2);
assert("loadBlacklistFacts excludes non-blacklisted", !facts.blacklisted.includes("0x9999999999999999999999999999999999999999"));
assert("loadBlacklistFacts includes blacklisted", facts.blacklisted.includes("0x1111111111111111111111111111111111111111"));

console.log(`\nALL PASS (${passed} assertions)`);
