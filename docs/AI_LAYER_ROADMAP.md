# AI Ordering Layer MVP Roadmap

Tracks the AI ordering layer from 0 → tag `v3.3.0`. Each row corresponds to one ship-able PR.

**End-goal**: A user in **ChatGPT** or **Claude** says "find me an iPhone 15 under 500 USDC"; the LLM calls our public API, returns three vetted candidates with reputation badges; user picks one; LLM returns a short URL; user opens it; their wallet signs the EIP-712 PaymentAuth; v3.2 marketplace executes the order on-chain.

LLM agents **never** hold private keys. The agent always stops at "here is a sign URL"; the wallet completes settlement. This is the only safe architecture under non-custodial Web3 semantics.

## Phase progress

| Phase | Scope | Status |
|---|---|---|
| I.1 | Postgres full-text + trigram search infra (`/api/search/products`) | **[x]** |
| I.2 | NLU + candidate filter pipeline (Claude API tool-use) backing `/api/ai/recommend` | **[x]** |
| I.3 | Public API surface: auth (wallet binding), `/api/ai/search`, `/api/ai/draft-order` returning unsigned PaymentAuth + sign-URL | [ ] |
| I.4 | **ChatGPT Custom GPT** (OpenAPI spec → published to GPT Store) — primary user channel | [ ] |
| I.5 | **Claude MCP server** (self-hosted HTTP MCP + apply for Anthropic Apps directory) | [ ] |
| I.6 | Seller agent (optional; create-product flow over the same public API) | [ ] |

Phases are sequential up to I.3. I.4 and I.5 are parallel entry points over the same backend; either can ship first without blocking the other. `v3.3.0` ships when **I.4 or I.5** lands publicly with at least one real user-completed order.

**Earlier draft of this doc listed a Phase I.5 Web chatbox**. That direction is dropped: we don't want users to discover our marketplace through our own website chat — we want them to discover it from inside the LLM app they already use every day.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Entry points (LLM apps the user already has installed)             │
│    • ChatGPT (Custom GPT + GPT Store, Phase I.4) ← primary          │
│    • Claude (HTTP MCP + Apps directory, Phase I.5)                  │
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
│  Phase I.2: NLU + recommend pipeline (already shipped)              │
│    Claude Sonnet 4.6 with tool-use → SearchProductsInput            │
│    Phase I.1 search → reputation filter → risk engine → top 3       │
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
| LLM | Claude Sonnet 4.6 (`claude-sonnet-4-6`) | Tool-use reliability + already used elsewhere in the repo |
| Search | Postgres `tsvector` + `pg_trgm` | "简单第一". Zero new deps |
| Input validation | Zod | Project standard |
| Rate limit | `lib/rateLimit.ts` + Phase I.2 in-memory `budget.ts` | Same per-IP throttle pattern; Redis upgrade pre-mainnet |
| Public auth | SIWE → JWT (Phase I.3) | Re-use existing SIWE infra; tokens are addr-scoped |
| ChatGPT integration | OpenAPI 3.1 spec + Custom GPT in GPT Store | Lowest user friction (zero-config in ChatGPT app) |
| Claude integration | HTTP MCP server + (apply for) Anthropic Apps directory | MCP for power users; Apps directory for mass discovery |

## Out-of-scope (deliberate)

- **Web chatbox on our own site** — see header. The point of this layer is that users don't *come to our site*; they stay in their LLM.
- **Self-hosted LLM**: pre-PMF, Claude API is faster, cheaper, better. Revisit at $10k+/month spend.
- **Vector embeddings**: `tsvector + trigram` covers our SKU count for a long runway.
- **Agent-held private keys / agent-completed purchases**: non-negotiable. We never give an LLM signing authority over user funds.

## Status flags as of this commit

- I.1: shipped.
- I.2: code + tests shipped. Live LLM round-trip pending the operator's `ANTHROPIC_API_KEY` in `.env`; module fast-fails with HTTP 503 until it's set.
- I.3 onward: not yet started.

## How to use this file

Same protocol as `docs/ROADMAP.md`: tick a Phase in the same PR that ships it. Don't pre-tick aspirational items.
