# Web Chatbox Guide (`/shop`)

The web chatbox is the ChainUs-owned entry point to the AI ordering
layer, parallel to the [ChatGPT Custom GPT](./CHATGPT_CUSTOM_GPT_SETUP.md)
lane shipped in Phase I.4. Both surfaces talk to the same backend
(Phase I.3 endpoints).

---

## For end users

1. Visit `https://chainus.org/shop`.
2. Connect a wallet (top-right) on a supported chain (Arbitrum Sepolia
   in MVP). Sign the SIWE prompt — your address is now the AI's session
   identity for rate-limit and budget purposes.
3. Type what you want, e.g.:
   - "find me an iPhone under 500 USDC"
   - "cheapest bluetooth headphones"
   - "show me what's new under 0.01 ETH"
4. The assistant returns up to 3 candidates, each with:
   - Product name + on-chain ID
   - Price in ETH and approximate mUSD (mock 1 ETH ≈ 3,000 mUSD on
     testnet)
   - Seller reputation badge — `★ NNN` (high-trust ≥ 700) or `New
     seller (N orders)` for sellers below the on-chain history floor
   - A one-line "why this one" rationale
5. Click **Buy** on the candidate you want. Your wallet pops up at
   `/sign/{draftId}` with the EIP-712 PaymentAuth + the transaction
   that calls `marketplace.createAndPayWithAuth`. You pay the gas
   (≈ $0.01 on Arbitrum) and confirm.
6. After confirmation the page routes to the order detail view where
   you can track shipping and trigger receipt-confirmation when the
   item arrives.

Chat history is in-memory only — refreshing the page wipes it. That is
deliberate; we don't keep a record of your shopping queries on the
server. If you want a persistent history, screenshot the candidates.

---

## For developers

### Architecture

```
                       ┌────────────────────────────────────┐
  User in /shop ──────▶│ ShopChatBox (client component)     │
                       │   POST /api/ai/recommend            │
                       └─────────────┬──────────────────────┘
                                     ▼
                       ┌────────────────────────────────────┐
                       │ /api/ai/recommend route             │
                       │  · rate-limit (per-IP)              │
                       │  · daily budget cap (per-IP)        │
                       │  · calls recommendProducts()        │
                       └─────────────┬──────────────────────┘
                                     ▼
                       ┌────────────────────────────────────┐
                       │ lib/ai/recommend.ts                 │
                       │  · NLU stage (lib/ai/nlu.ts)        │
                       │  · search (lib/search/products)     │
                       │  · reputation filter                │
                       │  · risk engine                      │
                       └─────────────┬──────────────────────┘
                                     ▼
                       ┌────────────────────────────────────┐
                       │ lib/ai/llm/                         │
                       │  resolveLLMProvider()               │
                       │    auto: DeepSeek > OpenAI > Claude │
                       │    LLM_PROVIDER=<name> overrides    │
                       └────────────────────────────────────┘
```

Components:
- [`frontend/app/shop/page.tsx`](../frontend/app/shop/page.tsx) — server
  component, sets `<title>` and mounts the client chatbox.
- [`frontend/components/ai/ShopChatBox.tsx`](../frontend/components/ai/ShopChatBox.tsx)
  — owns the message list, the auth gate, and the input.
- [`frontend/components/ai/ChatMessage.tsx`](../frontend/components/ai/ChatMessage.tsx)
  — renders user / AI / system bubbles; mounts `ProductRecommendationCard`
  for AI messages that carry `candidates`.
- [`frontend/components/ai/ProductRecommendationCard.tsx`](../frontend/components/ai/ProductRecommendationCard.tsx)
  — one card per candidate. Buy button hits `/api/ai/draft-order` and
  routes to `/sign/[draftId]`.

The chat box does not introduce a new state library — it uses local
React state. SIWE auth re-uses [`useSiweAuth`](../frontend/lib/useSiweAuth.ts).
Wallet connect re-uses [`WalletButton`](../frontend/components/WalletButton.tsx).

### Switching LLM providers

Set one (or all) of these in `.env.local`:

```
DEEPSEEK_API_KEY=sk-...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
LLM_PROVIDER=auto       # or anthropic | openai | deepseek
```

If `LLM_PROVIDER` is unset or `auto`, the auto-detect order is
cost-ascending: DeepSeek → OpenAI → Anthropic. Set `LLM_PROVIDER`
explicitly to pin to a specific provider regardless of what other keys
are present.

The chat bubble for each AI response shows `via <provider> · <model> ·
$<cost>` so you can verify visually which provider served the request.

### Provider comparison

| Provider | Model | $/MT input | $/MT output | Caching | Latency p50 |
|---|---|---:|---:|---|---:|
| DeepSeek (default) | `deepseek-chat` | $0.14 | $0.28 | Auto (free; not surfaced) | ~1.2 s |
| OpenAI | `gpt-4o-mini` | $0.15 | $0.60 | Auto (free; not surfaced) | ~0.8 s |
| Anthropic | `claude-sonnet-4-6` | $3.00 (or $0.30 cached) | $15.00 | Explicit `cache_control: ephemeral` | ~1.4 s |

DeepSeek is ~20× cheaper than Anthropic for the NLU stage's typical
1.2 k-token system prompt + 60-token output, and quality is
indistinguishable at this task (it's a single function-call with a
narrow JSON schema). OpenAI is the sensible middle option when
DeepSeek's API is throttled or unreachable. Anthropic remains the
quality fallback and is what the I.4 ChatGPT lane uses if you pin it.

### Cost expectations at MVP scale

A single `/api/ai/recommend` round-trip on DeepSeek costs around
**$0.0002**. The in-memory daily budget cap (`AI_QUERY_DAILY_USD_CAP`
in `lib/ai/budget.ts`) defaults to $1/IP/day, which buys ~5,000
queries per IP at DeepSeek rates. Bump it for friends-and-family
testing; lower it for a public deploy.

### Debugging tips

- **Chatbox returns 503**: no provider key configured. Check the dev
  server's env load order — Next reads `frontend/.env`, then
  `frontend/.env.local`. The root `.env` is NOT auto-loaded; mirror
  any key you need there.
- **Provider returns 401 from the upstream API**: the SDK error
  message bubbles up via `withErrorBoundary` as a 500 here. Tail the
  Next dev server log to see the real reason.
- **Cost looks too high**: the cached-input column for Anthropic is
  only honoured on requests ≥ 1024 tokens. Below that, you pay full
  input rate. The I.2 system prompt is intentionally ≥1024 to clear
  the threshold.
- **DeepSeek tool-call returns malformed JSON**: rare, but possible
  when the model is overloaded. Re-run; the route returns 502 with
  a `NLUSchemaError` reason. The provider does NOT auto-retry.
- **Switching providers between requests**: provider clients are
  cached per-instance, not per-call. Restart the Next dev server
  after changing `LLM_PROVIDER` in `.env.local` so the cached client
  is dropped.

### Smoke test

```sh
cd frontend
npx tsx scripts/smokeWebChatbox.ts
```

The smoke walks through SIWE → `/api/ai/recommend` → `/api/ai/draft-order`
and reports the provider that served the request. See script header for
required env.
