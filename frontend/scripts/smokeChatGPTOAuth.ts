// End-to-end smoke for Phase I.4 — ChatGPT Custom GPT OAuth flow.
//
// Simulates the four-step dance a real ChatGPT Action does, without
// actually involving ChatGPT:
//
//   1. GET  /oauth/authorize        → expect 302 → /oauth/connect
//   2. SIWE: nonce + signMessage + /api/auth/siwe/verify (sets cookie)
//      POST /api/oauth/grant         (with cookie) → auth code
//   3. POST /api/oauth/token         (with client_secret + code) → JWT
//   4. POST /api/ai/search           (Bearer JWT) → candidates
//      POST /api/ai/draft-order      (Bearer JWT) → unsigned payload
//
// No on-chain submission — I.3's smokeAIDraftOrder.ts already covers
// that path. The goal here is to prove the bearer issued via the OAuth
// authorization-code flow can reach the AI endpoints end-to-end, with
// the same response shapes the OpenAPI spec advertises.
//
// Required env (the smoke fails-fast and prints what to set):
//   PRIVATE_KEY                — buyer key for the SIWE step
//   OAUTH_CLIENT_SLOTS         — must include the slot we read below
//   OAUTH_CLIENT_<SLOT>_*      — id/secret/redirect URIs registered in
//                                lib/ai/oauthClients.ts
//   OAUTH_JWT_SECRET           — same secret the dev server reads
//   AI_SMOKE_BASE_URL          — defaults to http://localhost:3000
//   AI_SMOKE_OAUTH_SLOT        — defaults to "chatgpt"
//   AI_SMOKE_PRODUCT_ID        — defaults to 7
//
// Operator must have the Next dev server running and at least one
// active product on chainId 421614 whose seller != the buyer.

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });
dotenvConfig({ path: "../.env" });

import { createHash, randomBytes } from "node:crypto";

import { privateKeyToAccount } from "viem/accounts";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
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
      // Node's fetch exposes only `get("set-cookie")` which concatenates
      // multiple Set-Cookies with commas. headers.getSetCookie() is the
      // right API for the array form.
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

interface OAuthClient {
  slot: string;
  id: string;
  secret: string;
  redirectUri: string;
}

function readOAuthClient(): OAuthClient {
  const slot = (process.env.AI_SMOKE_OAUTH_SLOT ?? "chatgpt").toUpperCase().replace(/-/g, "_");
  const id = process.env[`OAUTH_CLIENT_${slot}_ID`];
  const secret = process.env[`OAUTH_CLIENT_${slot}_SECRET`];
  const redirects = process.env[`OAUTH_CLIENT_${slot}_REDIRECT_URIS`];
  if (!id || !secret || !redirects) {
    fail(
      `OAuth client "${slot}" is not registered. Either run scripts/registerChatGPTOAuthClient.ts and copy the env block into .env, or set AI_SMOKE_OAUTH_SLOT to a slot that already exists in OAUTH_CLIENT_SLOTS.`
    );
  }
  const first = redirects.split(",")[0]?.trim();
  if (!first) fail(`OAUTH_CLIENT_${slot}_REDIRECT_URIS is empty`);
  const slots = process.env.OAUTH_CLIENT_SLOTS ?? "";
  if (!slots.split(",").map((s) => s.trim()).some((s) => s.toUpperCase().replace(/-/g, "_") === slot)) {
    fail(`Slot "${slot}" is configured but not listed in OAUTH_CLIENT_SLOTS=${slots}. Add it and restart the server.`);
  }
  return { slot, id, secret, redirectUri: first };
}

async function buildSiwe(address: string, nonce: string, baseUrl: string, chainId: number): Promise<string> {
  const issuedAt = new Date();
  const expirationTime = new Date(issuedAt.getTime() + 10 * 60_000);
  const host = new URL(baseUrl).host;
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Authenticate to view dispute evidence on ChainUs.",
    "",
    `URI: ${baseUrl}`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expirationTime.toISOString()}`
  ].join("\n");
}

async function main() {
  const baseUrl = process.env.AI_SMOKE_BASE_URL ?? "http://localhost:3000";
  const productId = Number(process.env.AI_SMOKE_PRODUCT_ID ?? "7");
  const buyerKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!buyerKey) fail("PRIVATE_KEY is not set");
  const oauth = readOAuthClient();
  const buyer = privateKeyToAccount(buyerKey);

  console.log(`base URL  = ${baseUrl}`);
  console.log(`buyer     = ${buyer.address}`);
  console.log(`OAuth slot= ${oauth.slot} (id=${oauth.id.slice(0, 12)}…)`);
  console.log(`redirect  = ${oauth.redirectUri}\n`);

  // 1) GET /oauth/authorize — expect 302 → /oauth/connect with same params.
  const state = randomBytes(12).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = pkceChallenge(codeVerifier);
  const authorizeUrl = new URL("/oauth/authorize", baseUrl);
  authorizeUrl.searchParams.set("client_id", oauth.id);
  authorizeUrl.searchParams.set("redirect_uri", oauth.redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "ai-agent");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const step1 = await fetch(authorizeUrl, { redirect: "manual" });
  if (step1.status !== 302 && step1.status !== 307) {
    const body = await step1.text();
    fail(`/oauth/authorize returned ${step1.status} (expected 302). Body: ${body.slice(0, 300)}`);
  }
  const location = step1.headers.get("location");
  if (!location || !location.includes("/oauth/connect")) {
    fail(`/oauth/authorize did not redirect to /oauth/connect (got ${location})`);
  }
  console.log(`✓ Step 1: /oauth/authorize → 302 → ${new URL(location, baseUrl).pathname}`);

  // 2) SIWE: nonce + sign + verify (cookie jar holds the session).
  const jar = makeCookieJar();

  const nonceRes = await fetch(`${baseUrl}/api/auth/siwe/nonce`, { method: "POST" });
  if (!nonceRes.ok) fail(`SIWE nonce failed: ${nonceRes.status}`);
  jar.ingest(nonceRes.headers);
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  const message = await buildSiwe(buyer.address, nonce, baseUrl, 421614);
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
  console.log("✓ Step 2a: SIWE verified, session cookie issued");

  // /api/oauth/grant requires the SIWE cookie and the OAuth params.
  const grantRes = await fetch(`${baseUrl}/api/oauth/grant`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar.header() },
    body: JSON.stringify({
      clientId: oauth.id,
      redirectUri: oauth.redirectUri,
      state,
      scope: "ai-agent",
      codeChallenge,
      codeChallengeMethod: "S256"
    })
  });
  if (!grantRes.ok) {
    const body = await grantRes.text();
    fail(`/api/oauth/grant failed: ${grantRes.status} ${body.slice(0, 300)}`);
  }
  const grant = (await grantRes.json()) as { redirectUrl: string };
  const redirectUrl = new URL(grant.redirectUrl);
  const code = redirectUrl.searchParams.get("code");
  const returnedState = redirectUrl.searchParams.get("state");
  if (!code) fail(`grant did not include code: ${grant.redirectUrl}`);
  if (returnedState !== state) fail(`state mismatch: sent ${state}, got ${returnedState}`);
  console.log(`✓ Step 2b: /api/oauth/grant → code ${code.slice(0, 16)}…`);

  // 3) Exchange code for a JWT bearer.
  const tokenForm = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oauth.redirectUri,
    client_id: oauth.id,
    client_secret: oauth.secret,
    code_verifier: codeVerifier
  });
  const tokenRes = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm.toString()
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    fail(`/api/oauth/token failed: ${tokenRes.status} ${body.slice(0, 300)}`);
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope?: string;
  };
  if (tokenJson.token_type !== "Bearer") fail(`unexpected token_type ${tokenJson.token_type}`);
  if (tokenJson.scope !== "ai-agent") fail(`unexpected scope: "${tokenJson.scope ?? ""}"`);
  console.log(`✓ Step 3: /api/oauth/token → access_token ${tokenJson.access_token.slice(0, 30)}… (expires_in ${tokenJson.expires_in}s, scope=${tokenJson.scope ?? "(none)"})`);

  // 4a) /api/ai/search. ANTHROPIC_API_KEY is optional in the env — the
  //     route returns 503 when it isn't set and we surface that as a
  //     "skipped" rather than a failure, so the smoke runs end-to-end
  //     on an LLM-less dev box too.
  const searchRes = await fetch(`${baseUrl}/api/ai/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokenJson.access_token}`
    },
    body: JSON.stringify({ query: "find me anything available" })
  });
  let searchSummary = "";
  if (searchRes.ok) {
    const body = (await searchRes.json()) as {
      recommendation: { candidates: Array<{ product: { id: number; name: string } }>; pipeline: unknown };
      caller: { address: string; via: string };
    };
    const ids = body.recommendation.candidates.map((c) => c.product.id);
    searchSummary = `${body.recommendation.candidates.length} candidates (ids=[${ids.join(",")}], caller via=${body.caller.via})`;
    console.log(`✓ Step 4a: /api/ai/search → ${searchSummary}`);
  } else if (searchRes.status === 503) {
    const body = await searchRes.text();
    searchSummary = "skipped (503 — ANTHROPIC_API_KEY not set; expected in LLM-less env)";
    console.log(`○ Step 4a: /api/ai/search → ${searchSummary} :: ${body.slice(0, 120)}`);
  } else {
    const body = await searchRes.text();
    fail(`/api/ai/search failed: ${searchRes.status} ${body.slice(0, 300)}`);
  }

  // 4b) /api/ai/draft-order — does not need the LLM.
  const draftRes = await fetch(`${baseUrl}/api/ai/draft-order`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokenJson.access_token}`
    },
    body: JSON.stringify({ productId })
  });
  if (!draftRes.ok) {
    const body = await draftRes.text();
    fail(`/api/ai/draft-order failed: ${draftRes.status} ${body.slice(0, 300)}`);
  }
  const draft = (await draftRes.json()) as {
    draftId: string;
    signUrl: string;
    payload: { message: { nonce: string; deadline: string } };
    token: { symbol: string; amount: string };
  };
  console.log(`✓ Step 4b: /api/ai/draft-order → signUrl ${draft.signUrl}`);
  console.log(`            draftId=${draft.draftId.slice(0, 12)}… nonce=${draft.payload.message.nonce} amount=${draft.token.amount} ${draft.token.symbol}`);

  console.log("\n────────────────────────────────────────────");
  console.log("Phase I.4 OAuth smoke: PASS");
  console.log(`Access token  : ${tokenJson.access_token.slice(0, 30)}…`);
  console.log(`Search result : ${searchSummary}`);
  console.log(`Sign URL      : ${draft.signUrl}`);
  console.log("────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
