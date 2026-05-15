# ChainUs Roadmap

Tracking what's left to build against the AI-driven product flow shown in
`docs/architecture-diagram.png` (the "ChainUs AI 选品下单流程架构图"). Anything
checked off has at least an MVP in `main`; anything unchecked is genuinely
not built.

This file is the source of truth for "what's pending". If you ship
something, tick it here in the same commit.

---

## 1. Layer-by-layer gap list

Layers follow the diagram top-to-bottom. Percentages are rough completion
estimates against the eventual production scope, not against an MVP.

### 1.1 User entry layer (~15%)

- [x] Web client (Next.js App Router)
- [ ] **AI conversational entry — MCP / Claude Apps integration.** Lets the
      user say "I want an iPhone 15 under 500 USDC" inside Claude desktop
      and have us return product picks + place an order draft. Single
      biggest brand differentiator on the diagram. *Est: 2 weeks.*
- [ ] **iOS / Android native app.** React Native is the obvious choice
      since wagmi + viem run there. Wallet UX (WalletConnect deep links)
      is the hard part. *Est: 2-3 months for a polished MVP.*
- [ ] **WeChat / Alipay mini program.** Requires a from-scratch UI in
      Taro / wechat-miniprogram framework; payment integration is
      regulated. *Est: 6-8 weeks.*
- [ ] **Open API for merchants / developers.** REST + API-key auth + rate
      limit + per-tenant analytics. *Est: 3-4 weeks.*

### 1.2 AI ordering layer — the differentiator (~40%, but only steps 4–7)

- [ ] **Step 1 — 需求理解 (NLU).** No LLM endpoint, no slot extraction.
      *Est: 1 week (Claude API + tool use).*
- [ ] **Step 2 — AI 选品推荐.** No recommendation pipeline. *Est: 1 week
      on top of step 1.*
- [ ] **Step 3 — AI 风险评估.** No risk model. *Est: 1 week to ship a
      simple "compute from existing order history" version.*
- [x] Step 4 — 创建订单草稿（人工版本已可用，AI 自动版本待 step 1-3）
- [x] Step 5 — 用户确认
- [x] Step 6 — Checkout（MetaMask / WalletConnect 签名）
- [x] Step 7 — 链上执行（escrow + 资金锁定）

### 1.3 AI capability layer (~0%)

All of these are net-new services we have not started:

- [ ] **NLU service** — parse free-text product intent into structured
      `{category, attributes, price_cap_wei, urgency}`. Recommend Claude
      API with tool use and prompt caching. *Est: 1 week.*
- [ ] **Search engine** — replace `prisma.product.findMany` with an
      indexed search (e.g. Postgres `tsvector` + trigram, or Meilisearch
      if we want fuzzy matching across descriptions). *Est: 3-4 days.*
- [ ] **Recommendation ranker** — feature vector per product
      `{price, seller_rep, delivery_speed, popularity_30d}` → score.
      Start with hand-tuned linear model; learn later. *Est: 1 week.*
- [ ] **Risk model** — per-seller risk score from on-chain history
      (dispute rate, refund rate, avg fulfilment time, dormancy). Pure
      SQL aggregation off `OnChainOrder` + `OnChainOrderV3_1` for MVP.
      *Est: 4-5 days.*
- [ ] **Logistics / delivery-time predictor** — uses 17track snapshots
      we already store + carrier statistics. Output: "expected
      delivery in X-Y days, P50/P90". *Est: 1 week.*
- [ ] **Price analysis** — compare listing price vs reference market
      (CoinGecko / CMC for crypto-priced goods; external price APIs for
      physical goods). *Est: 1-2 weeks depending on data sources.*
- [ ] **Reputation engine** — combines on-chain history, chat
      responsiveness, dispute outcomes. Powers risk model + UI badges.
      *Est: 1-2 weeks.*

### 1.4 System service layer (~70%)

- [x] **Product service** — CRUD, listing, image upload, seller-signed
      updates
- [x] **Order service** — V3 + V3.1 indexers, status tracking,
      transitions
- [x] **Payment service** — ETH / MATIC via wallet; createAndPayWithAuth
      (V3.1 single-sig); LI.FI cross-chain entry
- [x] **Stablecoin settlement (USDC / USDT / DAI).** v3.2 lane on Arbitrum
      Sepolia (`EscrowMarketplaceERC20`) accepts any ERC-20 the contract
      owner adds via `setAcceptedToken`. Currently mUSD (a test token)
      is registered; USDC / USDT / DAI on mainnet only need an
      allowlist tx after audit. Native path is unchanged.
- [x] **Notification service** — Resend email pipeline, per-kind dedup,
      email-on-status-change
- [ ] **Push notifications** — mobile / browser push. Wait until we have
      mobile clients.
- [x] **User service** — SIWE sessions, email binding, settings
- [ ] **Customer service tools** — admin chat / ticket inbox / refund
      escalation UI. Right now an admin can read evidence + chat via DB
      but there's no console. *Est: 1 week.*
- [x] **Seller service** — dashboard, shipping update with tracking
- [ ] **Seller analytics** — sales / revenue / dispute breakdown over
      time. *Est: 4-5 days.*

### 1.5 Smart contract layer (~75%)

- [x] **Escrow contract** — V2 + V3 (Arbitrum Sepolia) + V3.1
- [x] **Order management** — lifecycle, status transitions
- [x] **Payment settlement** — ETH/MATIC; cross-chain via LI.FI relayer
- [x] **Stablecoin settlement on-chain** — see 1.4
- [x] **Dispute contract** — open / resolve / refund flows
- [x] **Evidence registry** — V3 + V3.1 (separate deployments)
- [x] **Arbitration (Kleros V2)** — adapter wired for V3 on Arbitrum
      Sepolia
- [ ] **Kleros adapter for V3.1.** Same wiring as V3, just hasn't been
      deployed. *Est: 2-3 days.*
- [x] **Reputation contract (on-chain).** v3.2 `ReputationRegistry` is
      live on Arbitrum Sepolia. Score is computed off-chain over all
      marketplace lanes (`OnChainOrder` / `OnChainOrderV3_1` /
      `OnChainOrderV3_2`), the platform attestor signs an EIP-712
      `Attestation` (`subject, score, issuedAt, expiry, version`), and
      the registry stores the latest version per subject with monotonic
      replay protection. 2-step signer rotation via
      `setPendingSigner` / `acceptSigner`. See
      `contracts/v3_2/ARCHITECTURE.md`.
- [ ] **Seller bond / staking contract.** Sellers post a refundable
      bond to list; bond slashable on confirmed dispute outcomes.
      *Est: 1 week.*

### 1.6 Infrastructure layer (~15%)

- [x] **Postgres** (Prisma) for application state
- [x] **R2 / S3** storage for evidence + chat attachments
- [x] **Server-side RPC proxy** (`/api/rpc/[chain]`) with white-listed
      methods and per-IP rate limiting
- [ ] **Redis** for cross-node rate limits (chat send, RPC proxy,
      evidence upload, conversation send). Currently in-memory Maps
      that won't survive horizontal scaling. *Est: 2-3 days once we
      actually deploy >1 node.*
- [ ] **K8s / production deployment** — `helm` chart, env management,
      blue/green deploys. *Est: 1-2 weeks.*
- [ ] **Prometheus + Grafana** monitoring — RPC call rate, email send
      rate, indexer lag, error counts. *Est: 4-5 days.*
- [ ] **ELK / Loki log aggregation** — centralized log search. *Est:
      3-4 days.*
- [ ] **WAF / DDoS protection** — Cloudflare in front of the Next app,
      configured rate-limit rules. *Est: 2 days config-only once we
      have a domain.*
- [ ] **IPFS** option for evidence storage (currently local FS / R2
      only). Lets a hostile platform operator be replaced without users
      losing access to their dispute evidence. *Est: 1 week including
      content-addressed retrieval fallback.*
- [ ] **Multi-region backup + DR runbook.** *Est: 1 week.*

### 1.7 Governance + incentives (~0%)

- [ ] **$DATO platform token contract** (ERC-20 or ERC-20Votes).
      Decision before this: are we doing this at all? Token launches
      have regulatory and engineering cost; don't until product-market
      fit. *Est: 1 week contract + 2 weeks integration.*
- [ ] **Staking contract.** Sellers / arbitrators stake $DATO. *Est: 1
      week.*
- [ ] **Fee discount mechanism.** Holders pay reduced platform fees.
      *Est: 3-4 days.*
- [ ] **DAO governance contract** (OpenZeppelin Governor + Timelock).
      *Est: 2 weeks contract + 1 week UI.*
- [ ] **Treasury contract.** Platform fees → DAO treasury, with
      timelocked spend. *Est: 1 week.*
- [ ] **Proposal UI** + voting UI. *Est: 2 weeks.*

### 1.8 Risk control system (~5%)

- [x] **Credit / reputation rating** — MVP done. Score computed by
      `frontend/lib/reputation/score.ts` (v0 formula: base 500 ±
      completed-bonus, dispute / refund penalty, fulfilment lateness,
      account age bonus, capped 0..1000; sentinel 500 when
      `sampleSize < 5`). Visible as `ReputationBadge` on product /
      seller / order pages. Coefficients and `MIN_SAMPLE_SIZE` are
      tunable consts — leave alone until real-world data argues
      otherwise.
- [ ] **Risk rules engine** — declarative rules: "if seller's 30-day
      dispute rate > 5%, require additional confirmation step". *Est:
      1-2 weeks.*
- [ ] **Anomaly detection** — flag orders that look unusual vs the
      seller's baseline (way larger than typical, wallet just freshly
      funded, etc.). *Est: 1-2 weeks.*
- [ ] **Manual review queue** — admin UI to triage flagged orders.
      *Est: 1 week, mostly UI.*
- [ ] **Blacklist** — seller / buyer / chain-address. We have
      `EVIDENCE_ADMIN_ADDRESSES` env for the inverse (allowlist); need
      the inverse. *Est: 4-5 days.*

### 1.9 v3.2 完成情况快照 (2026-05-15)

v3.2 closes the "stablecoin settlement + portable on-chain reputation"
slice of the roadmap, end-to-end, on Arbitrum Sepolia:

- `EscrowMarketplaceERC20` — parallel marketplace that custodies funds
  itself (no separate Vault) and accepts native or any allowlisted
  ERC-20. Same 7-status lifecycle as v2 / v3.
- `ReputationRegistry` — EIP-712 attestation store, monotonic version,
  2-step signer rotation. Score formula is off-chain; the contract only
  verifies signatures + version + expiry.
- Indexer + Postgres schema (`OnChainOrderV3_2`, `IndexerStateV3_2`,
  `PublishedAttestation`, `ReputationRefreshQueue`) decoupled from v3 /
  v3.1 tables; `(chainId, marketplaceAddress, onChainOrderId)` is the
  unique key so v3 / v3.2 orderId collisions are physically impossible.
- Frontend URL `/orders/v3_2/[chainId]/[marketplace]/[orderId]`.
  Reputation badges render on product / seller / order pages. Admin
  dashboard exposes accepted-token allowlist, signer rotation, and the
  refresh-queue drain action.
- A demo seller has 8 Completed v3.2 orders + an on-chain attestation
  with `score=739, version=1`.

What's deliberately deferred (tracked in §2 carry-over below):

- Kleros adapter for v3.2
- Seller self-publish path for attestations (admin / cron publishes today)
- Email notifications for v3.2 events
- Evidence flow for v3.2 orders
- Shipping API / 17track integration on the v3.2 order page

---

## 2. Carry-over follow-ups (from completed sessions)

These were noted during earlier feature work; they're correctness or
quality issues on **already-shipped** code.

### 2.1 P0 — Blocking / known broken

- [ ] **11 failing hardhat tests** in `contracts/v3/EvidenceRegistryV3`,
      `EscrowMarketplaceV3`, `KlerosV2DisputeAdapter`,
      `v3_1/EscrowMarketplaceV3_1`. Caused by uncommitted security-audit
      contract changes in the working tree; need to either finish those
      changes or `git checkout` them. **Not** caused by frontend work.
- [ ] **Pre-launch UI verification** (still owed from messenger refactor)
      — confirm in two real wallet windows: thumbnail rendering, nav
      red dot, 6 MB / .pdf hard rejection, two-browser interaction,
      email delivery to a real address.

### 2.2 P1 — Reliability / cost

- [ ] **RPC proxy LRU cache** — `eth_call` keyed on
      `(method, params, blockNumber)`, 12s TTL. N concurrent users
      reading the same order multiplies upstream calls by N. *Est: 4-5
      hours.*
- [ ] **RPC proxy metrics / structured logs** — count + status per
      method per chain, surfaced to a `/api/rpc/_status` endpoint or
      Prometheus. *Est: 4-5 hours.*
- [ ] **V3.1 detail page DB fallback** — V3 detail page already
      synthesizes `OrderView` from the indexer cache when the on-chain
      read fails; V3.1 should do the same and disable polling on
      terminal-status orders. *Est: 2-3 hours.*
- [ ] **In-memory rate limits → Redis.** Affects chat send, conversation
      send, evidence upload, RPC proxy. Required before horizontal
      scaling. *Est: 1 day.*
- [ ] **`EvidenceUpload.marketplaceVersion` backfill.** Existing rows
      default to `'v3'`; if any V3.1 evidence was uploaded **before**
      the column existed it will be mis-tagged. Audit + fix script.
      *Est: 2-3 hours.*

### 2.3 P2 — Cleanup / hygiene

- [ ] **Delete orphan `frontend/components/chat/OrderChatPanel.tsx`**
      and the legacy `app/api/orders/[chainId]/[onChainOrderId]/chat/*`
      routes. The unified messenger has replaced them; the routes are
      no longer mounted from any UI surface. *Est: 30 min once we
      decide we don't want a backfill (see below).*
- [ ] **Backfill `OrderChatMessage` rows into `Conversation` /
      `ConversationMessage`.** Existing per-order chat history is
      currently invisible in the new UI. A one-shot script:
      for each `(chainId, onChainOrderId)`, look up the order's
      `(buyer, seller)` pair, get-or-create a Conversation, insert
      messages. *Est: 4-5 hours.*
- [ ] **Admin console** (read-only) for `EmailLog`, `EvidenceUpload`,
      `Conversation`. Right now only DB shell access. *Est: 1 day.*
- [ ] **`Contact seller` on product list cards**, not just detail page.
      *Est: 30 min.*
- [ ] **Indexer cron / supervisor.** Currently the V3 + V3.1 indexers
      need to be started manually (`npm run indexer`). Should run as a
      systemd service / k8s sidecar in production. *Est: 4-5 hours.*

#### v3.2 follow-ups (from Phase A–G work)

- [ ] **Kleros 仲裁 adapter for v3.2.** The contract has the same
      `openDispute` / `resolveDispute` surface as v3, so the adapter
      pattern from `KlerosV2DisputeAdapter` carries over. Not deployed
      yet. *Est: 2-3 days.*
- [ ] **Seller self-publish attestation.** The "Publish update on-chain"
      button on `ReputationBadge` (full variant) is disabled with a
      Coming soon tooltip. Wiring it up means letting the seller's
      wallet send `recordAttestation` themselves (calldata builder
      already exists in `publisher.ts`). *Est: 4-5 hours.*
- [ ] **Email notifications for v3.2.** `applyEventV3_2` does not call
      `queueNotification` like the v3 / v3.1 paths do. Wire `OrderPaid`
      / `OrderShipped` / `OrderCompleted` / `OrderDisputed` /
      `OrderRefunded` and tag with `marketplaceVersion="v3.2"` so the
      24h dedup key doesn't collide. *Est: 3-4 hours.*
- [ ] **Evidence flow for v3.2.** v3.2 doesn't yet have an
      EvidenceRegistry instance; the order detail page intentionally
      skips `<EvidenceSection />`. Either deploy a v3.2 registry or
      retarget the v3.1 one with marketplace-aware permission checks.
      *Est: 1 week including a fresh registry deploy.*
- [ ] **Shipping API / 17track integration on v3.2.** The v3.2 order
      detail page does not surface `TrackingLink` or
      `ShipWithTrackingDialog`. The data path exists (the same shipping
      columns are already absent from `OnChainOrderV3_2`; would need a
      separate table or a column add). *Est: 4-5 days.*
- [ ] **Reputation `MIN_SAMPLE_SIZE` / formula coefficient tuning.**
      Constants in `frontend/lib/reputation/score.ts` are picked from a
      back-of-envelope feel. Once we have order volume from real
      sellers, replay-fit the formula against expected risk outcomes.
      *Est: ongoing.*
- [ ] **`PublishedAttestation` `version` is `Int`** but the on-chain
      column is `uint8`. The issuer hard-caps at 255 today; once a
      seller approaches that, the schema needs a redesign (probably
      `(subject, registryAddr, version)` as the unique key + an
      explicit overflow handler). *Est: 1 day when a subject reaches
      v200+.*

### 2.4 P3 — Nice-to-have UX

- [ ] **Real-time updates** — WebSocket or SSE replacing 5s / 15s
      polling on chat panel, conversation list, inbox badge. *Est: 1-2
      days.*
- [ ] **Read receipts** — already record `ConversationLastSeen`; surface
      "Seen at X" under sent messages. *Est: 4-5 hours.*
- [ ] **Typing indicator.** Needs realtime first. *Est: 4-5 hours
      after realtime.*
- [ ] **Lightbox / image gallery for attachments** — currently clicking
      a thumbnail opens raw bytes in a new tab. *Est: 4-5 hours.*
- [ ] **HEIC server-side transcode to JPEG.** HEIC uploads currently
      look like broken images in Chrome / Firefox. *Est: 1 day.*

---

## 3. Out of scope (deliberately)

These keep coming up; documenting why we're **not** doing them:

- **Self-hosted LLM** — pre-PMF, Claude API is faster, cheaper, and
  better. Revisit at $10k+/month spend.
- **Cross-chain bridging beyond LI.FI integration** — we already proxy
  through LI.FI in V3.1. Building our own bridge = security nightmare.
- **Custodial wallet** for new users. Web3 product, non-custodial by
  design. Revisit if mass-market mobile demands it.
- **In-house arbitration** beyond admin emergency refund. Kleros covers
  this for V3; V3.1 adapter is queued (1.5 above). No reason to
  reinvent.

---

## 4. Decision points the maintainer must answer

These shape the roadmap and shouldn't be made by an agent without input:

1. **Are we launching a token?** (yes / no / later) — gates everything
   in §1.7.
2. **Mainnet target chain?** Arbitrum One is the obvious successor to
   Arbitrum Sepolia; need explicit confirmation before any production
   deploy scripts. Gates a chunk of §1.6.
3. **Mobile-first or web-first?** Affects whether iOS / Android in §1.1
   becomes P0 or stays P3.
4. **Acceptable Resend email volume for production?** $20/mo covers
   ~50k emails — we should know our break-even.

---

## 5. How to use this file

- Adding work: append a checkbox under the relevant subsection.
- Shipping work: tick the box **in the same PR** that ships it; do not
  defer the doc update — the file goes stale fast otherwise.
- Don't list trivial bugs here; use issues for those.
- Estimates are calendar-week estimates from a focused IC, not
  ideal-day estimates. Multiply by 1.5–2 for parallel ongoing work.
