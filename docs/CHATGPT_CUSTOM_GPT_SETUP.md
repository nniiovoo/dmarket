# ChatGPT Custom GPT — Setup Guide

This guide documents how to publish the **ChainUs Shopper** Custom GPT
against the Phase I.3 public AI API. Most of the work is in the OpenAI
Web UI; the API surface and OpenAPI spec are already shipped.

Audience: a ChainUs operator with `chainus.org` (or an ngrok tunnel) and
admin access to the deployment env. ChatGPT side requires a paid OpenAI
account (Plus / Team / Enterprise) to publish a GPT with Actions.

---

## 1. GPT identity (Configure → Basics)

| Field | Value |
|---|---|
| **Name** | `ChainUs Shopper` |
| **Description** | `Browse and order from ChainUs, the decentralized marketplace where on-chain escrow protects every purchase.` |
| **Profile picture** | Use the ChainUs logo (square, ≥512px). |
| **Conversation starters** (suggested) | `Find me an iPhone under 500 USDC`<br>`Show me the cheapest bluetooth headphones`<br>`What can I buy under 0.01 ETH right now?`<br>`I want a new mechanical keyboard` |
| **Capabilities** | Disable **Web Browsing**, **DALL·E**, **Code Interpreter**. The GPT only needs the Actions surface; extra capabilities increase the prompt-injection surface area. |

---

## 2. Instructions (system prompt)

Paste verbatim into Configure → Instructions:

```
You are the ChainUs Shopper, a buying assistant for the ChainUs
decentralized marketplace. Buyers pay sellers via on-chain escrow on
Arbitrum Sepolia; you help them find products and create order drafts.
You never handle wallets or private keys — every order ends with a
signing URL the user opens themselves.

## When the user asks to find something
1. Call the searchProducts action with the user's product intent in `q`.
   Extract price caps, chain preferences, and sort intent from the
   user's words. Do not invent fields the user did not state.
2. Present 2–3 top results. For each: name, price (in ETH and the
   approximate mUSD equivalent at 1 ETH ≈ 3000 mUSD for testnet demo
   purposes), seller's reputation score (0–1000) or "new seller" if
   `reputation.sentinel` is true, and a one-line reasoning.
3. Never invent products. If `candidates` is empty, tell the user
   explicitly that nothing matched and offer to broaden the query.

## When the user wants to buy
1. Confirm out loud: "I'll create a draft for <product name> at
   <price>. Open the sign URL when ready."
2. Call the createDraftOrder action with `productId` and the
   `expectedPriceWei` you observed in the search response.
3. Return the `signUrl` prominently and verbatim. Tell the user to:
   - Open the URL in their browser.
   - Connect the same wallet they used to authorize ChainUs Shopper.
   - Sign the EIP-712 PaymentAuth in their wallet (off-chain — no gas).
   - Submit the on-chain transaction (`createAndPayWithAuth`) — they
     pay the gas (≈ $0.01 on Arbitrum Sepolia).
   - The page redirects to the order detail view after confirmation.
4. NEVER ask for private keys, seed phrases, or wallet exports.
5. NEVER claim you have submitted a transaction yourself — only the
   user's wallet submits.

## Safety
- If a user asks you to send funds to an address, refuse — the agent
  does not move funds, ever.
- If a user asks you to "approve" tokens or call any contract function
  besides what the sign URL does: refuse, and tell them to visit
  chainus.org for any other on-chain action.
- On HTTP 429: tell the user the rate limit was hit; suggest waiting
  ~1 minute. If the 429 carries `costUsdSoFar`, explain that today's
  AI usage budget for their account has been reached.
- On HTTP 401: tell the user their authorization expired; ask them to
  reconnect via "Sign in with ChainUs" so a fresh OAuth token is
  issued.
- On HTTP 409 (price drift): tell the user the listed price moved and
  re-run search before drafting again.

## Voice
Concise. Treat the user as an adult who knows what crypto wallets do.
Don't pad responses with "as an AI" disclaimers. When you cite an order
or product, cite the numbers verbatim from the API response — never
guess.
```

(≈ 1850 characters, comfortably below ChatGPT's instruction cap.)

---

## 3. Actions (the API)

Configure → Actions → **Create new action**.

### 3.1 Import the OpenAPI spec

- **Schema → Import from URL**: `https://<PUBLIC_BASE_URL>/openapi.yaml`
- The serving route at `frontend/app/openapi.yaml/route.ts` reads the
  template at `frontend/public/openapi.template.yaml` and substitutes
  `${PUBLIC_BASE_URL}` at request time from `NEXT_PUBLIC_APP_ORIGIN`
  (with the request origin as a fallback). Verify with
  `curl $PUBLIC_BASE_URL/openapi.yaml | head -20` — the `servers.url`
  line must already be the absolute HTTPS URL, no `${...}` leftover.
  Next.js cannot host both a static file and a dynamic route at the
  same URL, which is why the source file uses the `.template` suffix.
- ChatGPT rejects `http://` and `localhost`. Use ngrok or a deployed
  origin.

### 3.2 Authentication

- **Authentication Type**: OAuth
- **Client ID**: value of `OAUTH_CLIENT_CHATGPT_ID` in the server env.
- **Client Secret**: value of `OAUTH_CLIENT_CHATGPT_SECRET`.
- **Authorization URL**: `${PUBLIC_BASE_URL}/oauth/authorize`
- **Token URL**: `${PUBLIC_BASE_URL}/api/oauth/token`
- **Scope**: `ai-agent`
- **Token Exchange Method**: *Default (POST request)* — our token
  endpoint accepts both `application/x-www-form-urlencoded` and JSON
  bodies, with `client_secret` either in the body or via HTTP Basic.

### 3.3 Privacy policy

ChatGPT requires a privacy policy URL. Point it at
`${PUBLIC_BASE_URL}/legal/privacy` (or your existing one). At minimum
the policy should disclose:

- The agent reads the user's wallet address and search queries.
- The agent never reads or stores private keys.
- AI usage is rate-limited and budgeted per wallet address.

---

## 4. Allowed domains

In Configure → Allowed Domains, list:

- The host of `${PUBLIC_BASE_URL}` (e.g. `chainus.org`).
- `sepolia.arbiscan.io` — so the GPT can render explorer links to the
  user without ChatGPT's exfil guard rejecting them.

Do NOT add wildcard domains. Do NOT add the buyer's wallet provider —
the agent never links out to a wallet.

---

## 5. Publish + redirect URI loop (the gotcha)

ChatGPT's OAuth callback URL is only known **after** you save the GPT
for the first time. The URL has the format:

```
https://chat.openai.com/aip/g-<GPT_ID>/oauth/callback
```

The `g-<GPT_ID>` segment is unique per GPT.

### One-time bootstrap

1. Save the GPT with a placeholder Authorization URL — ChatGPT will
   reveal the callback URL on save.
2. Copy the callback URL into the `OAUTH_CLIENT_CHATGPT_REDIRECT_URIS`
   env var on the server (comma-separated if you need more than one).
3. Restart the server / re-deploy so `lib/ai/oauthClients.ts` re-reads
   it. The client registry is cached after the first env read.
4. Save the GPT again. Click "Test" in the Actions panel — it should
   pop the SIWE landing page on `/oauth/connect`. Once you complete
   SIWE, ChatGPT receives the bearer and you're live.

If you see `redirect_uri_not_allowed` from the server, the callback URL
ChatGPT used does not match what's in env. The match is **exact-string**
— a trailing slash or a `?foo=bar` query parameter will break it
(intentional; see `lib/ai/oauthClients.ts:isAllowedRedirect`).

---

## 6. Publish checklist

| # | Step | Notes |
|---|---|---|
| 1 | Server env: `OAUTH_JWT_SECRET` set (≥ 16 chars). | I.3 prerequisite. |
| 2 | Server env: `OAUTH_CLIENT_SLOTS=chatgpt`. | Or add `chatgpt` to the existing CSV. |
| 3 | Server env: `OAUTH_CLIENT_CHATGPT_ID/SECRET/REDIRECT_URIS/NAME`. | Use `scripts/registerChatGPTOAuthClient.ts` to mint id+secret if you don't have them yet. |
| 4 | Server env: `NEXT_PUBLIC_APP_ORIGIN=https://<host>`. | Must be HTTPS. |
| 5 | Server env: `ANTHROPIC_API_KEY=sk-ant-...`. | Search 503s without it. |
| 6 | Re-deploy / restart. | Required after touching `OAUTH_CLIENT_*`. |
| 7 | `curl $PUBLIC_BASE_URL/openapi.yaml \| head` returns the spec with `${PUBLIC_BASE_URL}` substituted. |   |
| 8 | `curl $PUBLIC_BASE_URL/.well-known/oauth-authorization-server` returns 200 JSON. |   |
| 9 | `npx tsx frontend/scripts/smokeChatGPTOAuth.ts` returns ✓ on every step. | Validates OAuth + API surface without ChatGPT in the loop. |
| 10 | Open https://chat.openai.com → My GPTs → **Create**. |   |
| 11 | Fill Name, Description, Instructions, Profile picture. |   |
| 12 | Actions → **Import from URL** → `https://<host>/openapi.yaml`. | One Action covers all three endpoints. |
| 13 | Actions → Authentication → OAuth → fill in client + URLs (§3.2). |   |
| 14 | Save → copy the revealed callback URL into env → re-deploy → save again. | §5. |
| 15 | Test in the GPT preview: "Find me something under 0.01 ETH". | Should pop SIWE the first time, then return candidates. |
| 16 | Test the order flow: ask "Order it" → click the sign URL → wallet pops up. |   |
| 17 | Publish: choose **Only me** for the first day, then **Anyone with link**, then **Public** once you've verified at least one third-party user can complete an order. |   |

---

## 7. Known ChatGPT platform quirks

Document these so you don't re-discover them under pressure:

1. **Response size cap**: ChatGPT discards Action responses larger than
   approximately 100 KB. Our `searchProducts` response is bounded by
   the top-3 candidate cap plus the (truncated) `parsed` and
   `pipeline` blocks, well under that limit. If we ever raise the
   candidate cap, re-measure.
2. **No streaming responses**: Actions must return the full JSON body
   in one round trip. Don't chunk-encode.
3. **No Set-Cookie**: ChatGPT ignores cookies on Action responses; all
   per-user state lives in the bearer token.
4. **No file uploads** via Actions — products with images use
   `imageUrl` strings only.
5. **Latency**: ChatGPT times an Action out at ~45 seconds. NLU + DB +
   on-chain nonce read comfortably fits in 1-2 s on production RPC;
   public Arbitrum-Sepolia RPC can spike to 5-8 s when busy.
6. **One Action per GPT** (effectively) — multiple Actions are
   supported but the GPT picks per-call, which makes tool-routing
   unpredictable. We collapse our three endpoints into one OpenAPI
   spec for that reason.
7. **OAuth redirect_uri immutable** — once a GPT is published with one
   callback URL, deleting the GPT and recreating it generates a new
   `g-<GPT_ID>`. Plan to keep at least two redirect URIs in
   `OAUTH_CLIENT_CHATGPT_REDIRECT_URIS` if you intend to maintain a
   staging + production GPT in parallel.

---

## 8. Dev-loop via ngrok

For local iteration without redeploying:

```sh
# In one shell
cd frontend && npm run dev

# In another shell
ngrok http 3000
# → https://<random>.ngrok.app

# Then export the ngrok URL and restart Next so it picks up the new origin:
export NEXT_PUBLIC_APP_ORIGIN=https://<random>.ngrok.app
export OAUTH_CLIENT_CHATGPT_REDIRECT_URIS=https://chat.openai.com/aip/g-<id>/oauth/callback
cd frontend && npm run dev
```

`ngrok` is not added as a project dependency — it is an operator tool,
not part of the build. Install via `brew install ngrok` (macOS) or the
official binary.
