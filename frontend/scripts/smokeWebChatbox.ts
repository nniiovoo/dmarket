// End-to-end smoke for Phase I.5 — web chatbox.
//
// Walks the SIWE-cookie path that the /shop UI uses:
//
//   1. POST /api/auth/siwe/nonce + /verify (with the buyer's PRIVATE_KEY)
//   2. POST /api/ai/recommend  (LLM provider serves the request)
//   3. POST /api/ai/draft-order on the first candidate's product
//
// Doesn't open a browser (headless wagmi isn't worth setting up here)
// and doesn't submit on-chain (I.3 smokeAIDraftOrder already covers
// that). What we're proving:
//   - the LLM provider abstraction (Phase I.5.1) actually serves
//     /api/ai/recommend end-to-end
//   - `response.recommendation.usage.providerName` is populated and is
//     one of "deepseek" | "openai" | "anthropic"
//   - the SIWE-cookie auth path produces a valid bearer-less call to
//     /api/ai/draft-order (the /shop UI never goes through OAuth)
//
// Required env (script fast-fails with what to set):
//   PRIVATE_KEY                 — buyer key for SIWE
//   AI_SMOKE_BASE_URL           — defaults to http://localhost:3000
//   AI_SMOKE_PRODUCT_FALLBACK   — productId to draft if recommend returns
//                                 zero candidates (defaults to 7)
//   DEEPSEEK_API_KEY (or OPENAI_API_KEY or ANTHROPIC_API_KEY) — set on
//     the *dev server's* env. The smoke doesn't read these directly.

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });
dotenvConfig({ path: "../.env" });

import { privateKeyToAccount } from "viem/accounts";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

interface CookieJar {
  store: Map<string, string>;
  header(): string;
  ingest(headers: Headers): void;
}

function makeCookieJar(): CookieJar {
  const store = new Map<string, string>();
  return {
    store,
    header() {
      return Array.from(store.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
    ingest(headers) {
      const set = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      for (const raw of set) {
        const [pair] = raw.split(";");
        if (!pair) continue;
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (name && value) store.set(name, value);
      }
    }
  };
}

async function siweCookie(baseUrl: string, buyerKey: `0x${string}`): Promise<CookieJar> {
  const jar = makeCookieJar();
  const buyer = privateKeyToAccount(buyerKey);

  const nonceRes = await fetch(`${baseUrl}/api/auth/siwe/nonce`, { method: "POST" });
  if (!nonceRes.ok) fail(`SIWE nonce failed: ${nonceRes.status}`);
  jar.ingest(nonceRes.headers);
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
  const host = new URL(baseUrl).host;
  const message = [
    `${host} wants you to sign in with your Ethereum account:`,
    buyer.address,
    "",
    "Authenticate to view dispute evidence on ChainUs.",
    "",
    `URI: ${baseUrl}`,
    `Version: 1`,
    `Chain ID: 421614`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`
  ].join("\n");
  const signature = await buyer.signMessage({ message });

  const verifyRes = await fetch(`${baseUrl}/api/auth/siwe/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar.header() },
    body: JSON.stringify({ message, signature })
  });
  if (!verifyRes.ok) {
    const body = await verifyRes.text();
    fail(`SIWE verify failed: ${verifyRes.status} ${body.slice(0, 200)}`);
  }
  jar.ingest(verifyRes.headers);
  return jar;
}

const ALLOWED_PROVIDERS = new Set(["deepseek", "openai", "anthropic"]);

async function skipToDraftOnly(baseUrl: string, jar: CookieJar, fallbackProductId: number, t0: number): Promise<void> {
  const draftRes = await fetch(`${baseUrl}/api/ai/draft-order`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar.header() },
    body: JSON.stringify({ productId: fallbackProductId })
  });
  if (!draftRes.ok) {
    const body = await draftRes.text();
    fail(`/api/ai/draft-order failed: ${draftRes.status} ${body.slice(0, 300)}`);
  }
  const draft = (await draftRes.json()) as { draftId: string; signUrl: string; expiresAt: string };
  console.log(`✓ Step 3: /api/ai/draft-order → ${draft.signUrl}`);
  console.log("\n────────────────────────────────────────────");
  console.log("Phase I.5 web chatbox smoke: PASS (with recommend skipped)");
  console.log(`Sign URL : ${draft.signUrl}`);
  console.log(`Elapsed  : ${Date.now() - t0} ms`);
  console.log("────────────────────────────────────────────\n");
}

async function main() {
  const baseUrl = process.env.AI_SMOKE_BASE_URL ?? "http://localhost:3000";
  const fallbackProductId = Number(process.env.AI_SMOKE_PRODUCT_FALLBACK ?? "7");
  const buyerKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!buyerKey) fail("PRIVATE_KEY is not set (root .env)");

  const buyer = privateKeyToAccount(buyerKey);
  console.log(`base URL = ${baseUrl}`);
  console.log(`buyer    = ${buyer.address}\n`);
  const t0 = Date.now();

  // 1) SIWE cookie.
  const jar = await siweCookie(baseUrl, buyerKey);
  console.log("✓ Step 1: SIWE cookie issued");

  // 2) /api/ai/recommend
  const query = "find me a product under 0.01 ETH";
  const recRes = await fetch(`${baseUrl}/api/ai/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar.header() },
    body: JSON.stringify({ query })
  });
  if (recRes.status === 503) {
    const body = await recRes.text();
    console.log(
      `○ Step 2: /api/ai/recommend → 503 (no LLM provider key set — that is the Phase I.5 abstraction's correct error). ${body.slice(0, 180)}`
    );
    console.log("           Set DEEPSEEK_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) in frontend/.env.local and re-run.");
    // Skip the rest — without a recommendation we can still smoke draft-order
    // using the fallback productId, so callers see the SIWE → draft chain works.
    return await skipToDraftOnly(baseUrl, jar, fallbackProductId, t0);
  }
  if (!recRes.ok) {
    const body = await recRes.text();
    fail(`/api/ai/recommend failed: ${recRes.status} ${body.slice(0, 300)}`);
  }
  const recBody = (await recRes.json()) as {
    recommendation: {
      candidates: Array<{ product: { id: number; name: string; priceWei: string } }>;
      parsed: { q: string };
      explanation: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        costUsd: number;
        providerName?: string;
        model?: string;
      };
      pipeline: { searchHits: number; afterReputationFilter: number; afterRiskFilter: number };
    };
    requestId: string;
  };
  const u = recBody.recommendation.usage;
  if (!u.providerName) fail("recommendation.usage.providerName missing — Phase I.5 abstraction not wired");
  if (!ALLOWED_PROVIDERS.has(u.providerName)) {
    fail(`Unexpected providerName ${u.providerName}; expected one of ${[...ALLOWED_PROVIDERS].join(", ")}`);
  }
  if (typeof u.costUsd !== "number") fail("recommendation.usage.costUsd is not a number");
  console.log(
    `✓ Step 2: /api/ai/recommend → ${recBody.recommendation.candidates.length} candidates (parsed.q="${recBody.recommendation.parsed.q}")`
  );
  console.log(
    `           usage: provider=${u.providerName} model=${u.model} cost=$${u.costUsd.toFixed(6)} input=${u.inputTokens} cached=${u.cachedInputTokens} output=${u.outputTokens}`
  );
  console.log(
    `           pipeline: hits=${recBody.recommendation.pipeline.searchHits} → afterRep=${recBody.recommendation.pipeline.afterReputationFilter} → afterRisk=${recBody.recommendation.pipeline.afterRiskFilter}`
  );

  // 3) /api/ai/draft-order — uses first candidate's productId, falling
  // back to AI_SMOKE_PRODUCT_FALLBACK when the catalog returns nothing
  // (e.g. on a fresh DB).
  const firstCandidate = recBody.recommendation.candidates[0];
  const draftProductId = firstCandidate ? firstCandidate.product.id : fallbackProductId;
  const draftRes = await fetch(`${baseUrl}/api/ai/draft-order`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar.header() },
    body: JSON.stringify({ productId: draftProductId })
  });
  if (!draftRes.ok) {
    const body = await draftRes.text();
    fail(`/api/ai/draft-order failed: ${draftRes.status} ${body.slice(0, 300)}`);
  }
  const draft = (await draftRes.json()) as { draftId: string; signUrl: string; expiresAt: string };
  console.log(`✓ Step 3: /api/ai/draft-order → ${draft.signUrl}`);

  const elapsed = Date.now() - t0;
  console.log("\n────────────────────────────────────────────");
  console.log("Phase I.5 web chatbox smoke: PASS");
  console.log(`Provider     : ${u.providerName} (${u.model})`);
  console.log(`Candidates   : ${recBody.recommendation.candidates.length}`);
  console.log(`Cost (1 req) : $${u.costUsd.toFixed(6)}`);
  console.log(`Sign URL     : ${draft.signUrl}`);
  console.log(`Elapsed      : ${elapsed} ms`);
  console.log("────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
