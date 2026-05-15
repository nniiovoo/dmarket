# ChainUs Mainnet Deployment Runbook (Arbitrum One)

This document is a single, ordered checklist for taking the V3 / V3.1 stack from local + Arbitrum Sepolia onto **Arbitrum One mainnet**. Every step is concrete: which command, which env var, what to verify before continuing.

It is intentionally pessimistic. Each step has a "before you start" gate and a "verify before continuing" gate. If you can't satisfy the verify gate, stop and fix it before moving on. Money is involved.

> **Why Arbitrum One**: Kleros V2 is deployed there (mainnet jurors actually exist), Chainlink Functions is supported, and the rollup-level gas cost on Arbitrum is 10-20× cheaper than L1. This matches our Arbitrum Sepolia testing exactly — we only swap addresses, not architecture.

---

## 0. Pre-flight (do this once, before any deploy)

### Wallets

You need **three distinct addresses**, each holding mainnet ETH on Arbitrum:

| Role | What it does | Suggested funding |
|---|---|---|
| **Deployer EOA** | Deploys contracts, owns them initially | 0.05 ETH |
| **Multisig (Safe)** | Eventual owner of all contracts after handoff | 0.01 ETH (gas for confirmations) |
| **Owner-of-record** | The Kleros-adapter owner who can call `emergencyResolveDispute` | same as multisig |

The deployer can be a hot wallet — it only holds funds briefly. **The multisig must be a Gnosis Safe with ≥2 signers** before you touch mainnet.

> ⚠ Do **not** use the same private key that you used on testnet. Generate a fresh one for mainnet deployment, transfer ownership to the Safe, then archive the key.

### API keys / accounts ready

- [ ] **Arbitrum RPC**: Alchemy / Infura / QuickNode paid tier. Free tiers will rate-limit you. Save as `ARBITRUM_RPC_URL`.
- [ ] **Arbiscan API key**: `ARBISCAN_API_KEY` (for contract verification).
- [ ] **Chainlink Functions subscription** on Arbitrum One: created at https://functions.chain.link/arbitrum, funded with **≥ 5 LINK** (initial). Save subscription id as `FUNCTIONS_SUBSCRIPTION_ID`.
- [ ] **17track API key**: paid plan, not free trial (`TRACK17_API_KEY`).
- [ ] **Tracking lookup endpoint**: `TRACKING_LOOKUP_URL` must point at a production endpoint returning `{ trackingNumber, carrier }` for a given orderId. **This is mandatory on mainnet** — `configureV3Functions.ts` refuses to deploy without it (it would otherwise let every Shipped order get marked delivered from a single hard-coded tracking number).
- [ ] **Pinata account**: paid plan (free tier is rate-limited). `PINATA_JWT` with the `pinFileToIPFS` permission only.
- [ ] **Kleros template registered**: a court template on Kleros's TemplateRegistry describing how jurors should interpret a ChainUs dispute. Note the template id — you'll need it in step 4.

### Local repo state

- [ ] On a clean branch, no uncommitted changes.
- [ ] `npm install` clean (no peer-dep warnings affecting deploy).
- [ ] `npx hardhat test` — all 249+ tests pass locally.
- [ ] `npx tsc --noEmit` clean in `frontend/`.
- [ ] Reviewed every diff since the last Arbitrum Sepolia deploy.

### Add the mainnet network to hardhat

The current `hardhat.config.ts` defines `sepolia`, `amoy`, `arbitrumSepolia`. Add an `arbitrum` entry mirroring `arbitrumSepolia`:

```ts
arbitrum: {
  type: "http",
  chainType: "generic",
  chainId: 42161,
  url: configVariable("ARBITRUM_RPC_URL"),
  accounts: [configVariable("PRIVATE_KEY")]
}
```

Also extend the `explorerApiKey` resolver so `--network arbitrum` reads `ARBISCAN_API_KEY` (same key works for Arbitrum One and Arbitrum Sepolia on Etherscan v2).

Verify before continuing:
```bash
npx hardhat console --network arbitrum
# Inside: const n = await network.create(); await n.ethers.provider.getNetwork()
# Expect: chainId 42161n
```

### Root `.env` checklist

```
PRIVATE_KEY=0x...                                       # deployer EOA only
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/...
ARBISCAN_API_KEY=...

# Will be filled in as you deploy:
V3_ARBITRUM_VAULT_ADDRESS=
V3_ARBITRUM_MARKETPLACE_ADDRESS=
V3_ARBITRUM_EVIDENCE_REGISTRY_ADDRESS=
KLEROS_ARBITRATOR_ARBITRUM_ADDRESS=          # set below from Kleros's docs
KLEROS_ADAPTER_ARBITRUM_ADDRESS=

# Chainlink Functions
FUNCTIONS_SUBSCRIPTION_ID=...
TRACK17_API_KEY=...
TRACKING_LOOKUP_URL=https://api.chainus.app/tracking-lookup
```

`SELLER_PRIVATE_KEY` is **not** used in mainnet deployment — drop it for safety so a stray E2E script can't accidentally run on mainnet.

---

## 1. Deploy V3 marketplace + vault

The `deployV3.ts` script already supports any network in `hardhat.config.ts` provided that `FUNCTIONS_ROUTERS[networkName]` is set. Add the Arbitrum One router address to that map:

Edit `scripts/deployV3.ts`, in `FUNCTIONS_ROUTERS`, add:
```ts
arbitrum: "0x97083E831F8F0638855e2A515c90EdCF158DF238"
// Source: https://docs.chain.link/chainlink-functions/supported-networks (Arbitrum mainnet)
```

> Cross-check the router address on the Chainlink docs page at deploy time. Addresses change rarely but a wrong router silently breaks delivery oracle.

Then run:
```bash
npx hardhat run scripts/deployV3.ts --network arbitrum
```

Expected output:
```
V3 vault address:        0x...
V3 marketplace address:  0x...
V3 vault marketplace:    <marketplace address>   ← confirms wiring
```

**Verify before continuing**:
```bash
# Vault has correct marketplace pointer
cast call $V3_ARBITRUM_VAULT_ADDRESS "marketplace()(address)" --rpc-url $ARBITRUM_RPC_URL
# Should equal $V3_ARBITRUM_MARKETPLACE_ADDRESS

# Marketplace has correct vault
cast call $V3_ARBITRUM_MARKETPLACE_ADDRESS "vault()(address)" --rpc-url $ARBITRUM_RPC_URL

# Marketplace owner is deployer (will transfer later)
cast call $V3_ARBITRUM_MARKETPLACE_ADDRESS "owner()(address)" --rpc-url $ARBITRUM_RPC_URL
```

Copy the two addresses into `.env` (`V3_ARBITRUM_VAULT_ADDRESS`, `V3_ARBITRUM_MARKETPLACE_ADDRESS`).

Verify contracts on Arbiscan:
```bash
npx hardhat verify --network arbitrum $V3_ARBITRUM_VAULT_ADDRESS $DEPLOYER_ADDRESS
npx hardhat verify --network arbitrum $V3_ARBITRUM_MARKETPLACE_ADDRESS \
  $V3_ARBITRUM_VAULT_ADDRESS \
  0x97083E831F8F0638855e2A515c90EdCF158DF238 \
  "$(cat chainlink/functions/deliveryStatus.js)"
```

---

## 2. Deploy EvidenceRegistry

Add `arbitrum` to the `FUNCTIONS_ROUTER` map in `scripts/deployEvidenceRegistryV3.ts` (same value as step 1).

```bash
npx hardhat run scripts/deployEvidenceRegistryV3.ts --network arbitrum
```

Record `V3_ARBITRUM_EVIDENCE_REGISTRY_ADDRESS` from the output.

Wire it into the marketplace:
```bash
npx hardhat run scripts/wireMarketplaceToEvidenceRegistry.ts --network arbitrum
```

**Verify**:
```bash
cast call $V3_ARBITRUM_MARKETPLACE_ADDRESS "evidenceRegistry()(address)" --rpc-url $ARBITRUM_RPC_URL
# Should equal $V3_ARBITRUM_EVIDENCE_REGISTRY_ADDRESS

cast call $V3_ARBITRUM_EVIDENCE_REGISTRY_ADDRESS "marketplace()(address)" --rpc-url $ARBITRUM_RPC_URL
# Should equal $V3_ARBITRUM_MARKETPLACE_ADDRESS
```

Verify on Arbiscan (same pattern as marketplace).

---

## 3. Configure Chainlink Functions

This step uploads encrypted secrets (your 17track API key) to the DON and points the marketplace + registry at them.

Add an `arbitrum` entry to `NETWORK_CONFIG` in `scripts/configureV3Functions.ts`:

```ts
arbitrum: {
  routerAddress: "0x97083E831F8F0638855e2A515c90EdCF158DF238",
  donId: "fun-arbitrum-mainnet-1",
  donIdBytes32: "0x66756e2d617262697472756d2d6d61696e6e65742d310000000000000000000000",
  gatewayUrls: [
    "https://01.functions-gateway.chain.link/",
    "https://02.functions-gateway.chain.link/"
  ]
}
```

> Important: mainnet uses `functions-gateway.chain.link/` (no `testnet.` subdomain). Sanity-check the gateway URLs from Chainlink docs at deploy time.

Add the marketplace as an authorized consumer of your Functions subscription **via the Chainlink Functions UI**: https://functions.chain.link/arbitrum/<sub-id> → Add consumer → paste `V3_ARBITRUM_MARKETPLACE_ADDRESS`. Do the same for the registry.

Then run:
```bash
npx hardhat run scripts/configureV3Functions.ts --network arbitrum
npx hardhat run scripts/configureEvidenceRegistryV3.ts --network arbitrum
```

The first script will hard-refuse to run if `TRACKING_LOOKUP_URL` is unset on `arbitrum` (it's in the `mainnetNetworks` guard). If you see that error, fix the env — do **not** patch the guard.

**Verify**:
```bash
cast call $V3_ARBITRUM_MARKETPLACE_ADDRESS "subscriptionId()(uint64)" --rpc-url $ARBITRUM_RPC_URL
# Should equal your $FUNCTIONS_SUBSCRIPTION_ID

cast call $V3_ARBITRUM_MARKETPLACE_ADDRESS "donID()(bytes32)" --rpc-url $ARBITRUM_RPC_URL
# Should equal the donIdBytes32 above
```

Smoke-test the oracle path with a low-value test order **before** mainnet launch (see step 6).

---

## 4. Deploy Kleros V2 adapter

Find the live Kleros V2 KlerosCore address for Arbitrum One. As of 2025, this should be in https://github.com/kleros/kleros-v2/tree/master/contracts/deployments/arbitrum (look for `KlerosCore_Proxy.json`).

Add it to `KNOWN_REAL_KLEROS` in `scripts/deployKlerosAdapterV3.ts`:
```ts
const KNOWN_REAL_KLEROS: Record<string, string> = {
  arbitrumSepolia: "0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479",
  arbitrum: "0x...."  // ← real mainnet KlerosCore
};
```

> **Sanity-check the address by reading `arbitrator()` on a known existing Kleros V2 dispute adapter** (e.g. the Kleros Curate one). Wrong arbitrator means disputes go to a contract with no jurors.

Also update the `arbitratorExtraData` court choice for mainnet:
```ts
networkName === "arbitrumSepolia" || networkName === "arbitrum"
  ? AbiCoder.defaultAbiCoder().encode(["uint96", "uint256"], [<courtId>, <minJurors>])
  : "0x"
```

Use a **court id** appropriate for e-commerce disputes (likely General Court = 1) and a **minJurors** ≥ 3. Confirm the court id in the Kleros V2 court tree; this is the value that determines how much you pay in arbitration fees per dispute.

Set the template id you registered in step 0:
```ts
const templateId = <your template id>n;
```

Run:
```bash
npx hardhat run scripts/deployKlerosAdapterV3.ts --network arbitrum
```

Record `KLEROS_ADAPTER_ARBITRUM_ADDRESS` in `.env`.

**Verify**:
```bash
cast call $KLEROS_ADAPTER_ARBITRUM_ADDRESS "arbitrator()(address)" --rpc-url $ARBITRUM_RPC_URL
# = real Kleros KlerosCore (not Mock)

cast call $KLEROS_ADAPTER_ARBITRUM_ADDRESS "marketplace()(address)" --rpc-url $ARBITRUM_RPC_URL
# = $V3_ARBITRUM_MARKETPLACE_ADDRESS
```

Migrate marketplace ownership to the adapter:
```bash
npx hardhat run scripts/migrateMarketplaceToKlerosAdapter.ts --network arbitrum
```

**Verify**:
```bash
cast call $V3_ARBITRUM_MARKETPLACE_ADDRESS "owner()(address)" --rpc-url $ARBITRUM_RPC_URL
# = $KLEROS_ADAPTER_ARBITRUM_ADDRESS
```

After this, `marketplace.resolveDispute()` can be invoked only via `adapter.rule()` (Kleros callback) or `adapter.emergencyResolveDispute()` (adapter owner).

---

## 5. Optional: deploy V3.1 marketplace (cross-chain pay)

V3.1 is only needed if you want to accept cross-chain payments with a single signature (relayer submits buyer's signed `PaymentAuth`). If you're launching with the two-step LI.FI bridge + tx flow, **skip this step**.

V3.1 deploys *alongside* V3 — separate vault, separate Functions subscription consumer. There is no migration path from V3 to V3.1 for in-flight orders; V3.1 starts with nextOrderId=1.

Create `scripts/deployV3_1.ts` as a copy of `deployV3.ts`, but:
- Change the contract factory to `EscrowMarketplaceV3_1`
- Deploy a fresh `EscrowVaultV3` for it
- Print the new addresses as `V3_1_ARBITRUM_VAULT_ADDRESS` / `V3_1_ARBITRUM_MARKETPLACE_ADDRESS`

Then repeat steps 2-4 against the V3.1 marketplace (separate registry, separate adapter, separate Functions consumer).

> Recommendation: launch V3 first, prove dispute flow with real jurors on at least one case, then deploy V3.1 once cross-chain pay is the bottleneck.

---

## 6. Smoke test on mainnet (low-value real run)

Before announcing, do one end-to-end real-money run. Pick a real product, ~$5 USD equivalent. Use a side wallet you control as the seller.

```bash
# Modify scripts/sepoliaTest/02_lifecycleAndEvidence.ts to point at:
#   V3_ARBITRUM_VAULT_ADDRESS / V3_ARBITRUM_MARKETPLACE_ADDRESS / V3_ARBITRUM_EVIDENCE_REGISTRY_ADDRESS
# Then run against arbitrum.
```

What you're proving:
- [ ] `createAndPay` works (Created + Paid emitted, vault holds funds)
- [ ] `markShipped` → `requestDelivery` → Chainlink callback fires within 3 minutes
- [ ] `confirmReceived` releases to seller (pull-payment `pendingWithdrawal` updated)
- [ ] `seller.withdraw` actually transfers ETH out of the vault
- [ ] Indexer (running with `INDEXED_CHAIN_IDS` including 42161 once added) picks up the new order

Also do one dispute path:
- [ ] Open dispute → wait 3 days → adapter owner calls `emergencyResolveDispute` (don't wait for Kleros jurors on the smoke test; real Kleros disputes take days-weeks)

If anything in the smoke test surprises you, **stop and investigate**. Do not invite real users until smoke test is green.

---

## 7. Ownership handoff to Safe

Until this step, the deployer EOA owns everything. That's a single point of failure. Transfer to the multisig:

```bash
# 1. Vault owner (already immutable in code — vault.owner is set in constructor;
#    skip this. Vault ownership cannot be changed.)
# Actually: EscrowVaultV3 sets `owner` as immutable. If you deployed with the
# deployer EOA as owner, you cannot change it. Two options:
#   (a) Accept this and rely on the marketplace being the only path to vault
#       state-changing functions (lockFunds, releaseTo*), which it is.
#   (b) Redeploy vault with the Safe as initialOwner before deploying anything
#       else — easiest done before step 1 if you've decided this matters.
# Recommended: (a). The owner-only functions on vault are limited to
# setMarketplace, which can only be called once and has already been called.

# 2. Marketplace owner — currently the Kleros adapter. The adapter has its own owner.

# 3. Kleros adapter owner — currently the deployer EOA. Transfer to Safe:
cast send $KLEROS_ADAPTER_ARBITRUM_ADDRESS \
  "transferOwnership(address)" $SAFE_ADDRESS \
  --rpc-url $ARBITRUM_RPC_URL --private-key $DEPLOYER_PK

# The adapter uses Ownable (not Ownable2Step). Ownership transfer is immediate.

# 4. Evidence registry owner — currently the deployer EOA. Transfer to Safe:
cast send $V3_ARBITRUM_EVIDENCE_REGISTRY_ADDRESS \
  "transferOwnership(address)" $SAFE_ADDRESS \
  --rpc-url $ARBITRUM_RPC_URL --private-key $DEPLOYER_PK
```

**Verify**:
```bash
cast call $KLEROS_ADAPTER_ARBITRUM_ADDRESS "owner()(address)" --rpc-url $ARBITRUM_RPC_URL
cast call $V3_ARBITRUM_EVIDENCE_REGISTRY_ADDRESS "owner()(address)" --rpc-url $ARBITRUM_RPC_URL
# Both should = $SAFE_ADDRESS
```

From here on, every privileged action (resolve dispute, refund, change settings) requires a Safe proposal.

---

## 8. Frontend cutover

Update `frontend/.env.local`:
```
NEXT_PUBLIC_V3_ARBITRUM_MARKETPLACE_ADDRESS=0x...
NEXT_PUBLIC_V3_ARBITRUM_VAULT_ADDRESS=0x...
NEXT_PUBLIC_V3_ARBITRUM_EVIDENCE_REGISTRY_ADDRESS=0x...
NEXT_PUBLIC_KLEROS_ADAPTER_ARBITRUM_ADDRESS=0x...
NEXT_PUBLIC_ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/...

# Also for the indexer:
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/...
INDEXER_ARBITRUM_FROM_BLOCK=<deploy block + 1>
```

Code changes:
- `frontend/lib/chains.ts`: change `PRIMARY_CHAIN_ID` from `421614` (Arbitrum Sepolia) to `42161` (Arbitrum One).
- `frontend/lib/contracts.ts`: add a `getV3ContractAddresses(42161)` branch reading `NEXT_PUBLIC_V3_ARBITRUM_*` env.
- `frontend/lib/indexer/config.ts`: add `arbitrum.id` to `ALL_CANDIDATE_CHAINS`, add `DEPLOYMENT_BLOCK[42161]` reading `INDEXER_ARBITRUM_FROM_BLOCK`, add `arbitrum` branches to `getIndexerChain`, `getIndexerMarketplaceAddress`, `getIndexerEvidenceRegistryAddress`, `getRpcUrl`.
- LI.FI is already chain-agnostic but verify the destination is set to chainId 42161 in `frontend/lib/lifi.ts`.

Deploy frontend with `next build` and a fresh `vercel deploy --prod` (or equivalent). Confirm `/api/health` returns OK from production URL.

Start the indexer on the production worker:
```bash
cd frontend && npm run indexer
# Watch for: "[chain 42161] live watch started (marketplace + registry)"
```

Run the closed-loop verification (port `05_verifyIndexerCloseLoop.ts` to `arbitrum` network) — same script that proved Stage 2a on Arbitrum Sepolia.

---

## 9. Operational hardening

- [ ] Set up **Arbiscan email alerts** for `OrderDisputed`, `DisputeResolved`, `DeliveryQueryFailed` events. Owner should see disputes in real time, not weeks later.
- [ ] **PagerDuty / Slack webhook** wired to indexer logs. Indexer death = no new orders shown in UI = looks down.
- [ ] **Funded Chainlink Functions subscription**: set a low-balance alert (≤ 1 LINK triggers a top-up).
- [ ] **17track quota monitoring**: if oracle calls start failing with `429`, you've exceeded the daily quota — bump the plan tier.
- [ ] **Pinata bandwidth alerts**: similar, free tier is heavily rate-limited.
- [ ] **Kleros V2 court watcher**: subscribe to events from your adapter on Arbiscan so you see when juror rulings arrive.

---

## 10. Rollback plan

What if something is wrong post-launch?

**Pausable everything**:
```bash
# Safe proposal: marketplace.pause()  → no new pay/ship/confirm/dispute/oracle
# Funds in flight are NOT trapped — cancelOrder, resolveDispute, and
# ownerEmergencyRefund stay available so locked funds can always be unwound.
```

**Stuck order recovery**: `scripts/recoverStuckOrder.ts` (exists in repo) walks stuck orders through `ownerEmergencyRefund` after the 30/60-day delays elapse. For pre-delay rescues, a Safe-proposed `resolveDispute` is required.

**Bad Functions source code**: deploy a fixed version, then `proposeRequestSource` → wait 7 days → `commitRequestSource`. The 7-day delay is intentional — there is no way to skip it. **You cannot hot-patch the oracle source**.

If something more catastrophic is wrong (e.g. signature scheme bug in V3.1, vault bytecode discrepancy), the only safe action is to `pause()` everything, drain locked funds via `ownerEmergencyRefund` as orders age past the delay, and redeploy a fixed V3.2.

---

## Reference: chain-specific addresses

| Thing | Arbitrum Sepolia (testnet) | Arbitrum One (mainnet) |
|---|---|---|
| ChainID | 421614 | 42161 |
| Functions router | `0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C` | `0x97083E831F8F0638855e2A515c90EdCF158DF238` |
| Functions DON id | `fun-arbitrum-sepolia-1` | `fun-arbitrum-mainnet-1` |
| Functions gateway | `https://0X.functions-gateway.testnet.chain.link/` | `https://0X.functions-gateway.chain.link/` |
| Kleros KlerosCore | `0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479` | *look up at deploy time* |
| Block explorer | https://sepolia.arbiscan.io | https://arbiscan.io |

Always double-check the mainnet values from official Chainlink + Kleros docs **on the day of deploy** — addresses change rarely but mistakes here are not recoverable.
