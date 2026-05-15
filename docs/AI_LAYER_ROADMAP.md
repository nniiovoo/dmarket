# AI Ordering Layer MVP Roadmap

Tracks the AI ordering layer from 0 → tag `v3.3.0`. Each row corresponds to one ship-able PR.

**End-goal**: A user in **ChatGPT** or **Claude** says "find me an iPhone 15 under 500 USDC"; the LLM calls our public API, returns three vetted candidates with reputation badges; user picks one; LLM returns a short URL; user opens it; their wallet signs the EIP-712 PaymentAuth; v3.2 marketplace executes the order on-chain.

LLM agents **never** hold private keys. The agent always stops at "here is a sign URL"; the wallet completes settlement. This is the only safe architecture under non-custodial Web3 semantics.

## Phase progress

| Phase | Scope | Status |
|---|---|---|
| I.1 | Postgres full-text + trigram search infra (`/api/search/products`) | **[x]** |
| I.2 | NLU + candidate filter pipeline (Claude API tool-use) backing `/api/ai/recommend` | **[x]** |
| I.3 | Public API surface: auth (wallet binding), `/api/ai/search`, `/api/ai/draft-order` returning unsigned PaymentAuth + sign-URL | **[x]** |
| I.4 | **ChatGPT Custom GPT** (OpenAPI spec → published to GPT Store) — primary user channel | **[x]** (spec + setup guide + OAuth smoke) |
| I.5 | **Web chatbox on `/shop`** + multi-provider LLM (DeepSeek / OpenAI / Anthropic) + `chainus.org` cleanups | **[x]** (shipped 2026-05-15, tag `v3.3.0`) |
| I.6 | **Claude MCP server** (self-hosted HTTP MCP + apply for Anthropic Apps directory) | [ ] — deferred follow-up |
| I.7 | Seller agent (optional; create-product flow over the same public API) | [ ] |

Phases were sequential up to I.3. I.4 (ChatGPT) and I.5 (Web chatbox + multi-provider) both ship over the same backend; either is enough to constitute the MVP. `v3.3.0` ships with **both** entry points live and an on-chain smoke covering the GPT lane end-to-end.

**Direction change**: an earlier draft of this doc deferred the Web chatbox entirely in favour of ChatGPT-only distribution. We reversed that in Phase I.5 — owning the experience for users who don't already use ChatGPT was a cheap second channel (one page + one chat component), and shipping a web surface that talks to the same API surface as the GPT validated the abstraction. The MVP closes with both lanes live; Claude MCP becomes the optional third lane.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Entry points                                                       │
│    • ChatGPT (Custom GPT + GPT Store, Phase I.4) ← public reach     │
│    • Web chatbox at chainus.org/shop (Phase I.5) ← we own UX        │
│    • Claude MCP (Phase I.6, deferred)                               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ free-text intent + auth token
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Phase I.3: public, auth'd HTTP API                                 │
│    /api/ai/search       → ranked candidates                         │
│    /api/ai/draft-order  → unsigned PaymentAuth + sign URL           │
│    /api/auth/connect    → SIWE-based wallet binding                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ unsigned draft
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Phase I.2: NLU + recommend pipeline                                │
│    LLM provider (Phase I.5 abstraction):                            │
│      DeepSeek  · deepseek-chat   · $0.14/MT in, $0.28/MT out [def]  │
│      OpenAI    · gpt-4o-mini     · $0.15/MT in, $0.60/MT out        │
│      Anthropic · claude-sonnet-4-6 · $3 / $0.30 cached / $15        │
│    → SearchProductsInput → Phase I.1 search → reputation → top 3    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ candidates
                               ▼
                  user clicks sign URL → wallet pop-up
                               │
                               ▼
              v3.2 marketplace.createAndPayWithAuth
```

The contract layer is locked at v3.2. The AI layer is strictly an entry-point reshape that culminates in the same wallet signature the buy-flow already produces.

## Wallet binding (the critical mechanic)

LLMs cannot hold private keys, so every entry point follows the same hand-off:

1. **First-time bind**: user runs the GPT/MCP, agent says "click here to connect your wallet". User opens our SIWE page (`/auth/connect`), signs a message in their wallet → server issues a scoped API token bound to that address.
2. **Per-purchase**: agent calls `/api/ai/draft-order` with the bound token. Server stores the unsigned PaymentAuth in a short-TTL row, returns a single sign-URL.
3. **Settlement**: user opens the URL in their phone/desktop, wallet pops up the EIP-712 PaymentAuth, signs it, marketplace tx fires.

This is the same hand-off pattern used by Coinbase Onramp, Hop UI, and every other "LLM-aware" Web3 product in 2026. We add no novel cryptography.

## Tech stack decisions

| Concern | Choice | Why |
|---|---|---|
| LLM | DeepSeek `deepseek-chat` default · OpenAI `gpt-4o-mini` · Anthropic `claude-sonnet-4-6` (Phase I.5 abstraction) | DeepSeek at ~$0.14/MT input is ~20× cheaper than Sonnet for the NLU stage. Auto-detect picks the cheapest configured provider; `LLM_PROVIDER=<name>` forces one. Anthropic is still the only provider where we surface prompt caching. |
| Search | Postgres `tsvector` + `pg_trgm` | "简单第一". Zero new deps |
| Input validation | Zod | Project standard |
| Rate limit | `lib/rateLimit.ts` + Phase I.2 in-memory `budget.ts` | Same per-IP throttle pattern; Redis upgrade pre-mainnet |
| Public auth | SIWE → JWT (Phase I.3) | Re-use existing SIWE infra; tokens are addr-scoped |
| ChatGPT integration | OpenAPI 3.1 spec + Custom GPT in GPT Store | Lowest user friction (zero-config in ChatGPT app) |
| Claude integration | HTTP MCP server + (apply for) Anthropic Apps directory | MCP for power users; Apps directory for mass discovery |

## Out-of-scope (deliberate)

- **Self-hosted LLM**: pre-PMF, third-party APIs are faster, cheaper, and better-maintained. Revisit at $10k+/month spend.
- **Vector embeddings**: `tsvector + trigram` covers our SKU count for a long runway.
- **Agent-held private keys / agent-completed purchases**: non-negotiable. We never give an LLM signing authority over user funds.
- **Persistent chat history on `/shop`**: by design — refresh wipes the thread. Persisting threads server-side mixes cost-scaling concerns with privacy concerns and would block on a "data deletion request" UX before mainnet.

## Status flags as of this commit

- I.1: shipped.
- I.2: code + tests shipped. Live LLM round-trip pending the operator's `ANTHROPIC_API_KEY` in `.env`; module fast-fails with HTTP 503 until it's set.
- I.3: code + tests shipped (dual-auth, OAuth 2.0 code-exchange, `DraftOrder` model, `/sign/[id]` wallet handoff). Live end-to-end pending operator's `OAUTH_JWT_SECRET` + at least one registered `OAUTH_CLIENT_*` slot in `.env`; the bearer-auth path fast-fails with HTTP 503 until set. SIWE-cookie callers (Web chatbox) work without OAuth env. **On-chain smoke ✓** (Arbitrum Sepolia tx `0x8ae22b0b…d648aa4233f`, order #12).
- I.4: code + spec + docs shipped. Public OpenAPI 3.1 template lives at [`frontend/public/openapi.template.yaml`](../frontend/public/openapi.template.yaml) and is served at `${PUBLIC_BASE_URL}/openapi.yaml` via [`frontend/app/openapi.yaml/route.ts`](../frontend/app/openapi.yaml/route.ts), which substitutes `${PUBLIC_BASE_URL}` at request time. (The `.template` suffix exists because Next.js cannot register a dynamic route at the same path as a static `public/` file.) GPT publishing checklist + system prompt + ngrok dev-loop in [`docs/CHATGPT_CUSTOM_GPT_SETUP.md`](CHATGPT_CUSTOM_GPT_SETUP.md). OAuth flow E2E smoke at `frontend/scripts/smokeChatGPTOAuth.ts`. Live publish pending operator action in the OpenAI Web UI.
- I.5: shipped 2026-05-15 (tag `v3.3.0`). Three deliverables:
  1. **Multi-provider LLM abstraction** at [`frontend/lib/ai/llm/`](../frontend/lib/ai/llm) — DeepSeek default (cheapest), OpenAI / Anthropic optional, auto-detect by env. NLU stage was rewritten to talk to the abstraction instead of the Anthropic SDK directly; `/api/ai/recommend` response shape is back-compat with the I.2 contract (usage now also carries `providerName` + `model`, additive).
  2. **Web chatbox at `/shop`** — [`app/shop/page.tsx`](../frontend/app/shop/page.tsx) + [`components/ai/`](../frontend/components/ai) (ShopChatBox, ChatMessage, ProductRecommendationCard). SIWE-gated. Buy button hits `/api/ai/draft-order` and routes to `/sign/[id]`.
  3. **`chainus.org` domain cleanup** — SIWE message + MAINNET runbook updated; no `chainus.xyz` / `chainus.app` left.
- I.6 onward: not yet started.

## How to use this file

Same protocol as `docs/ROADMAP.md`: tick a Phase in the same PR that ships it. Don't pre-tick aspirational items.
