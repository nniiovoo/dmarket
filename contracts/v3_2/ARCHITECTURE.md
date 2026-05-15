# ChainUs v3.2 Escrow Architecture

v3.2 is a parallel marketplace lane, not an upgrade of v3.1. It introduces ERC-20 settlement and an on-chain reputation registry. v2 / v3 / v3.1 deployments are unchanged; orders already on those contracts stay there.

## 1. Design goals

### 1.1 Why v3.2 is a parallel lane, not a v3.1 inheritor

v3 and v3.1 are bound to native-only payments and pipe every payment through `EscrowVaultV3`, whose surface (`lockFunds`, `releaseToBuyer`, `releaseToSeller`) is hard-coded to `payable` ETH transfers. Retrofitting that path to accept USDC / USDT / DAI would mean either editing the frozen v3 vault to add token branches — which CLAUDE.md §8 forbids — or layering an adapter that pulls ERC-20 into the marketplace, wraps it, and somehow round-trips through a payable vault. Both options leak ERC-20 concerns into v3.

Inheriting from `EscrowMarketplaceV3_1` is also a dead end: its constructor mandates a vault address and a Chainlink Functions router, both of which are native-only / oracle-coupled and unrelated to the ERC-20 problem. A WIP draft that pretends to be v3.1+ would inherit dead state (`subscriptionId`, `donID`, `requestSource`, pending source proposals) that has no meaning for an ERC-20 lane.

So v3.2 is a *parallel* lane: a self-contained marketplace that keeps the v3.1 signed-auth UX (EIP-712 `PaymentAuth` + nonces) and the v3.1 state machine, but custodies funds itself (native or ERC-20) and drops the Chainlink delivery oracle. The v3.1 contract on Sepolia stays the canonical native lane; v3.2 only handles the stablecoin path.

### 1.2 Why marketplace self-custodies ERC-20 (no Vault)

The "钱独立住，业务都住一起" split was justified for v2 / v3 because the vault knew nothing about orders — its API was just `lock` / `release` indexed by `orderId`. Adding ERC-20 to that surface means either:

- per-token bookkeeping inside the vault (a new map for each accepted token), or
- a generic vault that doesn't actually own the assets and just acts as a router.

Both lose the property that made the vault valuable (small surface, audit-friendly). For v3.2 we collapse the two: `EscrowMarketplaceERC20` holds the funds directly. Funds are still segregated by order state (`Created` / `Paid` / `Shipped` / `Disputed` orders' amounts are owed to either buyer or seller; everything else is zero). The conservation invariant (§2.3) keeps the same shape — it's just inside one contract now.

### 1.3 Why ReputationRegistry is an independent contract

v3.1's signer key authorizes *payment* authorizations bound to a specific `orderId` / amount / nonce per buyer. Reputation attestations are a different artifact:

- long-lived statements about a `subject` (any user, not necessarily a buyer in a particular order)
- monotonic `version` per subject to defeat replay of stale scores
- portable across marketplace deployments and chains

Co-locating attestation verification inside v3.1 would bind reputation to a single marketplace's EIP-712 domain (defeating portability), entangle two unrelated rotation policies (payment-relayer signer vs. platform-attestor signer), and bloat v3.1 with schema and storage unrelated to order flow. `ReputationRegistry` is therefore a thin verifier/store with no on-chain scoring logic — scores are computed off-chain by the platform, the contract only checks EIP-712 signatures, replay-by-version, and expiry.

## 2. `EscrowMarketplaceERC20` state machine

### 2.1 Order lifecycle (identical to v2 / v3)

```
Created ──pay──► Paid ──ship──► Shipped ──confirm──► Completed
   │              │              │
   │              │              └──dispute──► Disputed ──resolve──► Completed / Refunded
   │              └──cancel──► Cancelled
   └──cancel──► Cancelled
```

Seven statuses, same enum order as v2 / v3 / v3.1 so the indexer's status-int mapping is shared.

### 2.2 What's different vs v3.1

| Aspect | v3.1 | v3.2 |
|---|---|---|
| Custody | Separate `EscrowVaultV3` | Marketplace holds funds directly |
| Payment asset | Native only (ETH/MATIC) | Native **or** allowlisted ERC-20 |
| `Order` struct | no `paymentToken` | adds `paymentToken: address` (zero = native) |
| Pay flow | `payOrder` (native) | `payOrder` (native) + `payOrderERC20` (token, needs prior approve) |
| Signed auth | `createAndPayWithAuth(PaymentAuth, sig)` | Same shape, plus `paymentToken` in the auth schema |
| Token allowlist | n/a | `setAcceptedToken(addr, bool)` (owner-only) |
| Delivery oracle | Chainlink Functions | Not wired (no `autoConfirmAfterDelivery`) |
| Auto-confirm | Yes, after `deliveredAt + 10 days` | No — buyer must `confirmReceived` or owner `resolveDispute` |
| Reentrancy | `ReentrancyGuard` on pay paths | Same |
| Pausable | Yes | Yes |

### 2.3 Fund conservation invariant

For any token `T` (including native, `T = address(0)`):

```
marketplace.balanceOf(T) == Σ order.amount
                            for every order o where
                              o.paymentToken == T
                              AND o.status ∈ {Paid, Shipped, Disputed}
```

The invariant holds because every state transition either moves an order into the inflow set (`Paid` adds it), keeps it inside (`Shipped` / `Disputed` don't touch the balance), or moves it out by transferring the exact `order.amount` to the destination party (`Completed` releases to seller, `Refunded` releases to buyer). Reentrancy is gated, and `_payout` is CEI — state flips before the transfer.

`Cancelled` orders never paid funds in, so they don't contribute. `Created` orders haven't paid yet either.

## 3. `ReputationRegistry` design

### 3.1 Off-chain compute, on-chain verify

The split:

| | Computed off-chain | Stored on-chain |
|---|---|---|
| Score (`uint16`, 0..1000) | yes (`frontend/lib/reputation/score.ts`) | yes |
| Components (completed orders, dispute rate, etc.) | yes | **no** |
| Issued-at / expiry timestamps | yes (signer chooses) | yes |
| Version (`uint8`, monotonic per subject) | yes | yes |
| Signature recovery | n/a | yes |

The contract is intentionally dumb: a 100-line verifier that accepts any signed `Attestation` whose `version > stored.version` and whose `expiry > now` (when present). All scoring policy lives in JS so the formula can iterate without a contract migration.

### 3.2 EIP-712 schema

```solidity
struct Attestation {
    address subject;   // the user the score refers to
    uint16  score;     // 0..1000 (uint16 leaves headroom)
    uint64  issuedAt;  // unix seconds, mostly informational
    uint64  expiry;    // unix seconds; 0 = no expiry; checked by recordAttestation
    uint8   version;   // monotonic per subject
}

ATTESTATION_TYPEHASH = keccak256(
    "Attestation(address subject,uint16 score,uint64 issuedAt,uint64 expiry,uint8 version)"
);

Domain = EIP712("ChainUsReputation", "1")
       = bound to (chainId, verifyingContract=registry)
```

### 3.3 Monotonic version + replay protection

`recordAttestation` requires `att.version > stored.version` (or, when the row doesn't exist yet, `att.version >= 1`). This means:

- the same signed attestation can be recorded at most once (replay → revert)
- a stale higher-versioned attestation cannot be displaced by a lower-versioned one
- the signer can publish out-of-order if needed — the chain rejects anything that doesn't strictly increase

The signer is responsible for picking the next version (the issuer reads `latest[subject].version` and uses `stored + 1`).

### 3.4 2-step signer rotation

Mirrors OpenZeppelin's `Ownable2Step`:

1. Owner calls `setPendingSigner(newSigner)`.
2. The pending signer wallet calls `acceptSigner()`. The contract checks `msg.sender == pendingSigner` and only then promotes.

This proves the new key is live and controllable before it becomes authoritative. Historical attestations remain verifiable — the registry doesn't re-validate prior signatures against the new signer, it just gates *new* `recordAttestation` calls.

### 3.5 Cross-marketplace portability

The registry's EIP-712 domain references the registry address itself, not any specific marketplace. Anyone with the registry address can call `verifyAttestation` and trust the result. Future v3.3 / v4 marketplaces can read the same registry without re-issuing scores; the score formula off-chain just needs to know which order tables to aggregate over (see `gatherSellerOrders` in `score.ts`, which unions `OnChainOrder` / `OnChainOrderV3_1` / `OnChainOrderV3_2`).

## 4. Interfaces and events

### 4.1 `EscrowMarketplaceERC20`

| Function | Caller | Effect |
|---|---|---|
| `createOrder(seller, paymentToken, productId, amount)` | anyone (becomes buyer) | Creates `Order` in `Created`. `paymentToken == 0` = native; non-zero must be allowlisted. |
| `payOrder(orderId)` payable | buyer | Pays a native order. `msg.value` must equal `order.amount`. |
| `payOrderERC20(orderId)` | buyer | Pulls `order.amount` of `order.paymentToken` via `safeTransferFrom`. Requires prior `approve`. |
| `createAndPayNative(seller, productId)` payable | buyer | Convenience: create + pay native in one tx. |
| `createAndPayWithAuth(PaymentAuth, sig)` payable | relayer | EIP-712 auth path; supports native or ERC-20 lanes. |
| `markShipped(orderId)` | seller | `Paid` → `Shipped`. |
| `confirmReceived(orderId)` | buyer | `Shipped` → `Completed`; releases funds to seller. |
| `cancelOrder(orderId)` | buyer | Only on `Created`. |
| `openDispute(orderId)` | buyer or seller | `Paid` / `Shipped` → `Disputed`. |
| `resolveDispute(orderId, refundBuyer)` | owner | Only after `disputedAt + 3 days`; releases to buyer or seller. |
| `setAcceptedToken(addr, bool)` | owner | Toggle the allowlist. Address(0) rejected. |
| `invalidateNonce()` | anyone (for own account) | Bumps `authNonces[msg.sender]` to invalidate outstanding EIP-712 auths. |
| `pause()` / `unpause()` | owner | Emergency brake; blocks everything except `cancelOrder` + `resolveDispute`. |

Events: `OrderCreated`, `OrderPaid`, `OrderShipped`, `OrderCompleted`, `OrderCancelled`, `DisputeOpened`, `DisputeResolved`, `OrderRefunded`, `AcceptedTokenUpdated`, `PaymentAuthExecuted`, `NonceInvalidated`. `OrderCreated` and `OrderPaid` carry `paymentToken` in their arg lists — the event signature differs from v2 / v3 / v3.1, so the indexer's `eventDecoderV3_2.ts` is independent of `eventDecoder.ts`.

### 4.2 `ReputationRegistry`

| Function | Caller | Effect |
|---|---|---|
| `verifyAttestation(att, sig) → bool` | anyone (view) | Returns true iff sig recovers to current signer, `expiry` not passed. Does **not** check version. |
| `recordAttestation(att, sig)` | anyone | Writes to `latest[subject]` after sig + version + expiry check. |
| `setPendingSigner(addr)` | owner | Propose new signer. |
| `acceptSigner()` | pending signer | Complete rotation. |
| `getAttestation(subject) → Attestation` | anyone (view) | Last stored attestation for `subject`. |
| `latest(subject)` | anyone (view) | Same data via auto-generated public getter. |

Events: `AttestationRecorded`, `SignerRotationProposed`, `SignerRotated`.

## 5. Compatibility with v3 / v3.1

- **No shared state.** v3.2 does not read or write v3 / v3.1 storage. The v3.1 Functions oracle, evidence registry, Kleros adapter, and vault all stay untouched.
- **Separate indexer tables.** `OnChainOrderV3_2` and `IndexerStateV3_2` live in their own Postgres tables. `(chainId, marketplaceAddress, onChainOrderId)` is the unique key — `v3.OrderId=1` and `v3.2.OrderId=1` are physically different rows.
- **Distinct order URL.** Frontend route is `/orders/v3_2/[chainId]/[marketplaceAddress]/[onChainOrderId]`. The legacy `/orders/[orderId]?chainId=…&marketplace=v3.2` URL is 308-redirected by the server wrapper at `app/orders/[orderId]/page.tsx`.
- **Reputation aggregates across lanes.** `gatherSellerOrders` in `score.ts` reads all four order tables (`OnChainOrder` / `OnChainOrderV3_1` / `OnChainOrderV3_2`, plus a placeholder for an eventual v2-only split) and combines them by lowercased seller address. A seller's score reflects their full ChainUs history regardless of which marketplace lane an order ran on.

## 6. Known limitations / future work

- **Fee-on-transfer / rebase tokens are not supported.** `payOrderERC20` assumes the exact `amount` arrives on `safeTransferFrom`. Tokens that take a fee mid-transfer would leave the marketplace short by the fee. The allowlist is the only gate today — operators must manually verify a token isn't fee-on-transfer before calling `setAcceptedToken`.
- **USDT approve-race is handled in the frontend only.** `useBuyNowERC20` does `approve(0)` then `approve(amount)` when an existing allowance is non-zero but insufficient. Tokens that revert on direct `approve` from non-zero will still get this treatment. No on-chain code change is needed.
- **No permit / EIP-2612 path.** Every ERC-20 buy is two-step (approve + pay). Adding permit would cut buyer interactions but requires a permit-aware variant of `payOrderERC20` and isn't on this phase's scope.
- **`resolveDispute` is `onlyOwner`.** v3 has a Kleros adapter; v3.2 doesn't yet. Same adapter pattern carries over (no contract change needed in `EscrowMarketplaceERC20` — only an adapter contract that the owner key authorises). Tracked in `docs/ROADMAP.md` §2.3.
- **`publisher.ts` awaits the tx receipt** before returning, to serialise back-to-back attestations against the relayer wallet's nonce. This was added during Phase E.5 when public Arbitrum Sepolia RPCs were lagging `eth_getTransactionCount`. On a paid RPC (Alchemy / Infura) the wait is essentially free; revisit if it becomes a throughput bottleneck.
- **EvidenceRegistry / shipping API not wired.** The v3.2 order detail page intentionally renders a minimal subset of components — no `<EvidenceSection />`, no `<TrackingLink />`, no `<ShipWithTrackingDialog />`. Tracked in `docs/ROADMAP.md` §2.3.
- **Reputation `version` is `uint8`.** A single subject is capped at 255 attestations. Issuer hard-checks this — beyond that limit the schema needs a redesign.
