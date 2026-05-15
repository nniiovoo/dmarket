// Smoke test for the risk rules engine.
// Run with: npx tsx scripts/smokeRiskEngine.ts

import { evaluate } from "../lib/risk/engine";
import { defaultRules, SELLER_BLOCKLIST } from "../lib/risk/defaultRules";
import type { Rule } from "../lib/risk/types";

let passed = 0;

function assert(label: string, cond: unknown): void {
  if (!cond) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
  console.log(`PASS ${label}`);
  passed++;
}

// ── comparison operators ─────────────────────────────────────────────────────

const opRules: Rule[] = [
  { id: "r-eq",  description: "", priority: 1, when: { op: "eq",  path: "x", value: 42 }, then: { type: "tag", tag: "eq"  } },
  { id: "r-ne",  description: "", priority: 1, when: { op: "ne",  path: "x", value: 42 }, then: { type: "tag", tag: "ne"  } },
  { id: "r-gt",  description: "", priority: 1, when: { op: "gt",  path: "x", value: 10 }, then: { type: "tag", tag: "gt"  } },
  { id: "r-gte", description: "", priority: 1, when: { op: "gte", path: "x", value: 42 }, then: { type: "tag", tag: "gte" } },
  { id: "r-lt",  description: "", priority: 1, when: { op: "lt",  path: "x", value: 50 }, then: { type: "tag", tag: "lt"  } },
  { id: "r-lte", description: "", priority: 1, when: { op: "lte", path: "x", value: 42 }, then: { type: "tag", tag: "lte" } },
];

const opResults = evaluate({ x: 42 }, opRules);
const opTags = opResults.map((r) => (r.action as { tag: string }).tag);
assert("op eq fires",  opTags.includes("eq"));
assert("op ne no-fire (42 ne 42 is false)", !opTags.includes("ne"));
assert("op gt fires",  opTags.includes("gt"));
assert("op gte fires", opTags.includes("gte"));
assert("op lt fires",  opTags.includes("lt"));
assert("op lte fires", opTags.includes("lte"));

// ── in / nin ─────────────────────────────────────────────────────────────────

const inRules: Rule[] = [
  { id: "r-in",  description: "", priority: 1, when: { op: "in",  path: "color", values: ["red", "blue"] }, then: { type: "tag", tag: "in"  } },
  { id: "r-nin", description: "", priority: 1, when: { op: "nin", path: "color", values: ["red", "blue"] }, then: { type: "tag", tag: "nin" } },
];
const inRes  = evaluate({ color: "red" }, inRules);
const ninRes = evaluate({ color: "green" }, inRules);
assert("in fires when value present",        inRes.some((r) => r.ruleId === "r-in"));
assert("nin no-fire when value present",     !inRes.some((r) => r.ruleId === "r-nin"));
assert("in no-fire when value absent",       !ninRes.some((r) => r.ruleId === "r-in"));
assert("nin fires when value absent",        ninRes.some((r) => r.ruleId === "r-nin"));

// ── and / or / not + short-circuit ───────────────────────────────────────────

// We verify short-circuit by checking that `and` stops on first false.
// Use rules whose paths resolve to undefined (falsy) for left-side of and.
const andRule: Rule = {
  id: "and-rule", description: "", priority: 1,
  when: { op: "and", clauses: [
    { op: "eq", path: "a", value: 1 },
    { op: "eq", path: "b", value: 2 },
  ]},
  then: { type: "tag", tag: "and" },
};
assert("and fires when all clauses true",  evaluate({ a: 1, b: 2 }, [andRule]).length === 1);
assert("and no-fire when first clause false", evaluate({ a: 9, b: 2 }, [andRule]).length === 0);

const orRule: Rule = {
  id: "or-rule", description: "", priority: 1,
  when: { op: "or", clauses: [
    { op: "eq", path: "a", value: 1 },
    { op: "eq", path: "b", value: 2 },
  ]},
  then: { type: "tag", tag: "or" },
};
assert("or fires when first clause true",  evaluate({ a: 1, b: 9 }, [orRule]).length === 1);
assert("or fires when only second true",   evaluate({ a: 9, b: 2 }, [orRule]).length === 1);
assert("or no-fire when none true",        evaluate({ a: 9, b: 9 }, [orRule]).length === 0);

const notRule: Rule = {
  id: "not-rule", description: "", priority: 1,
  when: { op: "not", clause: { op: "eq", path: "x", value: 42 } },
  then: { type: "tag", tag: "not" },
};
assert("not fires when inner is false", evaluate({ x: 99 }, [notRule]).length === 1);
assert("not no-fire when inner is true", evaluate({ x: 42 }, [notRule]).length === 0);

// ── missing path returns falsy, never throws ──────────────────────────────────

const missingRule: Rule = {
  id: "missing", description: "", priority: 1,
  when: { op: "gt", path: "deep.nested.val", value: 0 },
  then: { type: "tag", tag: "missing" },
};
assert("missing path is falsy, no throw", evaluate({}, [missingRule]).length === 0);
assert("partial path is falsy, no throw", evaluate({ deep: {} }, [missingRule]).length === 0);

// ── priority sort ─────────────────────────────────────────────────────────────

const prioRules: Rule[] = [
  { id: "low",  description: "", priority: 10, when: { op: "eq", path: "x", value: 1 }, then: { type: "tag", tag: "low"  } },
  { id: "high", description: "", priority: 99, when: { op: "eq", path: "x", value: 1 }, then: { type: "tag", tag: "high" } },
  { id: "mid",  description: "", priority: 50, when: { op: "eq", path: "x", value: 1 }, then: { type: "tag", tag: "mid"  } },
];
const prioRes = evaluate({ x: 1 }, prioRules);
assert("priority: high first",  prioRes[0].ruleId === "high");
assert("priority: mid second",  prioRes[1].ruleId === "mid");
assert("priority: low third",   prioRes[2].ruleId === "low");

// ── sample rule 1: elevated dispute rate ─────────────────────────────────────

const highDispute = { seller: { disputeRate30d: 0.1 }, order: { amountUsd: 100 }, buyer: { accountAgeDays: 30, address: "0xgood" } };
const lowDispute  = { seller: { disputeRate30d: 0.02 }, order: { amountUsd: 100 }, buyer: { accountAgeDays: 30, address: "0xgood" } };
const dr1 = evaluate(highDispute, defaultRules);
const dr2 = evaluate(lowDispute, defaultRules);
assert("rule1 fires on high dispute rate",     dr1.some((r) => r.ruleId === "elevated-dispute-rate"));
assert("rule1 no-fire on low dispute rate",    !dr2.some((r) => r.ruleId === "elevated-dispute-rate"));

// ── sample rule 2: high-value new buyer ───────────────────────────────────────

const hvNewBuyer  = { seller: { disputeRate30d: 0 }, order: { amountUsd: 6000 }, buyer: { accountAgeDays: 3, address: "0xgood" } };
const hvOldBuyer  = { seller: { disputeRate30d: 0 }, order: { amountUsd: 6000 }, buyer: { accountAgeDays: 30, address: "0xgood" } };
const lvNewBuyer  = { seller: { disputeRate30d: 0 }, order: { amountUsd: 100 },  buyer: { accountAgeDays: 3, address: "0xgood" } };
assert("rule2 fires on high-value new buyer",  evaluate(hvNewBuyer, defaultRules).some((r) => r.ruleId === "high-value-new-buyer"));
assert("rule2 no-fire when buyer is old",      !evaluate(hvOldBuyer, defaultRules).some((r) => r.ruleId === "high-value-new-buyer"));
assert("rule2 no-fire when amount low",        !evaluate(lvNewBuyer, defaultRules).some((r) => r.ruleId === "low-value-new-buyer"));

// ── sample rule 3: seller blocklist ──────────────────────────────────────────

// Add an address to the blocklist for the test, then restore.
SELLER_BLOCKLIST.push("0xbad");
const blockedFacts = { seller: { disputeRate30d: 0, address: "0xbad" }, order: { amountUsd: 1 }, buyer: { accountAgeDays: 100 } };
const cleanFacts   = { seller: { disputeRate30d: 0, address: "0xgood" }, order: { amountUsd: 1 }, buyer: { accountAgeDays: 100 } };
assert("rule3 fires on blocklisted address",   evaluate(blockedFacts, defaultRules).some((r) => r.ruleId === "seller-blocklisted"));
assert("rule3 no-fire on clean address",       !evaluate(cleanFacts, defaultRules).some((r) => r.ruleId === "seller-blocklisted"));
SELLER_BLOCKLIST.pop();

// ── disabled rule is skipped ──────────────────────────────────────────────────

const disabledRule: Rule = {
  id: "disabled", description: "", priority: 1, enabled: false,
  when: { op: "eq", path: "x", value: 1 },
  then: { type: "tag", tag: "disabled" },
};
assert("disabled rule is skipped", evaluate({ x: 1 }, [disabledRule]).length === 0);

console.log(`\nALL PASS (${passed} assertions)`);
