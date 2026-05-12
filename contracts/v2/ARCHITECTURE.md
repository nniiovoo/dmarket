# v2 Architecture: Marketplace + Vault

This is the recommended architecture for the escrow marketplace going forward.
Two contracts, one wiring step, one clear seam.

## Design philosophy

> **Money lives alone. Everything else stays together.**

The single resource that requires a different trust boundary from the rest of
the system is escrowed ETH. It gets its own contract (`EscrowVault`) because
holding funds is a category of risk fundamentally different from holding
order state.

Everything else — order lifecycle, status transitions, buyer/seller/owner
actions, dispute logic, admin escape hatches — lives in one contract
(`EscrowMarketplaceV2`) because these concerns are tightly coupled. Splitting
them would punch holes across cohesive logic for no real isolation benefit.

## The splitting heuristic

A module deserves its own contract when **any** of these is true:

1. **Independent risk** — distinct failure mode, distinct attack surface.
2. **Independent permissions** — different access-control model from neighbours.
3. **Independent funds** — separate value pool.
4. **Independent leverage** — multiple consumers reading from one source of truth.

Applied to this system:

| Concern | 1 | 2 | 3 | 4 | Verdict |
|---|---|---|---|---|---|
| ETH custody | ✅ | ✅ | ✅ | ❌ | **Split → `EscrowVault`** |
| Dispute resolution | ✅ | ✅ | ❌ | ❌ | Mixed: owner-only modifier handles permission isolation in-contract |
| Order state | ❌ | ❌ | ❌ | ❌ (today) | Stays inline; revisit in v1.0 |
| Payment orchestration | ❌ | ❌ | ❌ | ❌ | Stays inline (would be a shallow module) |

Dispute and order state could be split too, but at this stage doing so produces
shallow modules — interfaces nearly as complex as their implementations — which
makes the code harder to reason about, not easier.

## Module responsibilities

### `EscrowVault.sol`

Owns ETH. Nothing else.

- `lockFunds(orderId)` — accept payment from the marketplace, indexed by orderId.
- `releaseTo(orderId, recipient)` — transfer locked funds to a marketplace-chosen recipient.
- `setMarketplace(address)` — owner sets the single authorised caller.

The vault knows nothing about buyers, sellers, order status, or disputes. It
trusts the marketplace to choose correct recipients and is responsible only for:
holding the money safely and refusing unauthorised callers.

### `EscrowMarketplaceV2.sol`

Owns all order logic.

- Order storage, status enum, buyer/seller indexes.
- Buyer actions: `createOrder`, `payOrder`, `confirmReceived`, `cancelOrder`.
- Seller actions: `markShipped`.
- Both: `openDispute`.
- Owner actions: `resolveDispute`, `ownerEmergencyRefund`.
- Views: `getOrder`, `getBuyerOrders`, `getSellerOrders`.

The marketplace itself **never holds ETH**. All `payable` flows forward funds
to the vault; all release flows instruct the vault to transfer to a recipient.
The invariant `address(marketplace).balance == 0` is asserted in tests.

## Wiring step

After deployment, the vault owner must call:

```solidity
vault.setMarketplace(address(marketplace));
```

Without that step, `payOrder` reverts with `"Only marketplace can call this
function"`. The test `vault 没设置 marketplace 时 payOrder 会失败` codifies this.

This is the **only** post-deployment wiring step. Compare to the 4-module
version, which required 4 authorisation calls.

## Comparison to the other approaches in this repo

| Approach | Files | Wiring | Per-tx external calls | When to use |
|---|---|---|---|---|
| Monolith (`contracts/EscrowMarketplace.sol`) | 1 | 0 | 0 | Quickest path; throwaway prototype |
| **v2 (this folder)** | **2** | **1** | **1** | **Recommended for production** |
| 4-module (`contracts/modular/`) | 8 | 4 | 2+ | Future state when SellerBondVault, ReputationRegistry etc. need shared OrderManager |

All three are kept in the repo deliberately, as evolutionary checkpoints. The
v2 version is what should be deployed.

## Roadmap

The 4-criteria heuristic also describes when each future module should be
introduced. Order is rough — driven by product needs, not a fixed schedule.

```
v0.1 (current)         marketplace + vault                          ← we are here
v0.2 (pre-launch)      + Pausable (emergency brake)
                       + ProtocolFeeCollector (1-2% platform fee)
                       + deploy + wiring automation scripts
v1.0 (seller trust)    + SellerBondVault (3/4)
                       + ReputationRegistry (4/4 — multiple consumers)
                       — at this point OrderManager becomes a shared service
                         and the v2 marketplace should split into OrderRegistry
                         + marketplace shell.
v1.5 (economics)       + DatoToken (ERC20)
                       + StakingModule
v2.0 (governance)      + GovernanceDAO (3/4)
                       + InsurancePool (3/4)
                       + ProxyAdmin (if upgradeability is wanted)
```

Each module added is checked against the heuristic. If a proposed module
scores 0/4 or 1/4, it does not deserve to be its own contract — keep the
logic inline. **The heuristic exists to prevent shallow modules.**

## Why we kept the older approaches

`contracts/EscrowMarketplace.sol` and `contracts/modular/` are not deleted.
They serve as:

- **Reference points** — the monolith is the simplest correct version; useful
  for understanding what the v2 architecture is buying us.
- **Evolution evidence** — the modular version shows what "too far" looks
  like at this stage, and what v1.0 might evolve into when the heuristic
  starts scoring higher for OrderManager.

When v1.0 work begins, `contracts/modular/` will be a useful blueprint —
the OrderManager / DisputeManager / authorisation pattern there is exactly
what we'll need once SellerBondVault and ReputationRegistry land.
