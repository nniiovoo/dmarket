# v3.3 — Shop Asset Layer (Phase K)

**Status:** testnet-only WIP-DRAFT. Mainnet deployment is gated on a full
audit + legal review of the share-tokenisation design.

v3.3 turns each shop on the marketplace into a **transferable, on-chain
asset** with **fungible revenue shares**. The contract layer is
separate from v3.2 — v3.2 keeps running, untouched. v3.3 is a parallel
lane that adds shop identity, share ownership, and a per-order fee
split into share-pro-rata claims.

## Contracts

| Contract | Phase | Address (Arbitrum Sepolia) | Role |
|---|---|---|---|
| `ShopNFT` | K.1 | `0xA18A750B1d62dD6EE9a61565634e634654FCda2F` | One ERC-721 per shop. Transferable, but `_update` enforces 1-seller-1-shop. `shopIdOf[address]` is the source of truth elsewhere. |
| `ShopShares` | K.2 + K.3a | `0x625e45A4E5F6e9065dD4b158c23Cd6e3573B1950` | ERC-1155 with `tokenId == shopId` and `TOTAL_SUPPLY = 10 000` minted once at `initializeShares`. K.3a added a `settler` hook fired on every share movement. |
| `RevenueDistributor` | K.3a | `0x8d307e4173eD4a9c119b8D762a780Eb0aD59F4cb` | Per-share-index accumulator. `deposit` / `depositERC20` bumps the cumulative index; share transfers pre-credit holders via the `settle` callback; holders pull via `claim` / `claimAll`. |
| `EscrowMarketplaceV3_3` | K.3b | `0x7A99FE6C60281161C57369BbBB1Be197113Cfc4f` | Copy of v3.2 lifecycle + (a) `shopId` snapshot on every order, (b) on-completion split: 99 % seller / 1 % distributor (`feeRateBps` tunable up to 10 %). |
| `ShareMarket` | K.4 | `0x4BeDd1E3FFf03DFb18aFd5B5dF2daDCBF60b3532` | Approval-based, all-or-nothing listing market for ShopShares. Sellers post `(shopId, amount, paymentToken, totalPrice)`; buyers fill with one tx. Market holds no funds, no shares. |

K.3a + K.3b wiring:
- `shares.setSettler(distributor)` — share transfers trigger `settle`
- `distributor.setAuthorizedDepositor(marketplace, true)` — only the
  marketplace (and the owner) can deposit revenue

## Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│  Buyers / sellers                                                   │
└──────────────────┬──────────────────────────────────────────────────┘
                   │ createOrder / payOrder(ERC20) / confirmReceived
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  EscrowMarketplaceV3_3                                              │
│    - reads shopNft.shopIdOf(seller) at create time → Order.shopId   │
│    - on confirmReceived OR resolveDispute(refundBuyer=false):       │
│        seller += amount × (1 − feeRateBps / 10 000)                 │
│        distributor.deposit(...)  ← fee × paymentToken / shopId      │
└─────┬───────────────────────────────────────────┬───────────────────┘
      │                                           │
      ▼                                           ▼
┌─────────────┐                          ┌────────────────────────────┐
│  ShopNFT    │ ◀── shopIdOf(seller) ─── │  ShopShares                │
│  (K.1)      │                          │   (K.2 + K.3a settler)     │
└─────────────┘                          └─────────┬──────────────────┘
                                                   │ settle(shopId, holder)
                                                   ▼
                                         ┌────────────────────────────┐
                                         │  RevenueDistributor (K.3a) │
                                         │    cumulativeIndex[shop][t] │
                                         │    claimable[shop][t][who]  │
                                         └────────────────────────────┘
```

## Invariants

1. **1 seller, 1 shop** — `ShopNFT._update` rejects any transfer/mint
   into an address whose `shopIdOf != 0`. Verified end-to-end:
   `transfer to existing-shop owner reverts AlreadyOwnsShop`.
2. **Fixed share supply** — `ShopShares.TOTAL_SUPPLY = 10 000`, no
   mint after `initializeShares`, no burn. Sum of all holders' balances
   for any initialised shopId is exactly 10 000.
3. **Investor invariant** — `Order.shopId` is snapshotted at
   `createOrder` time. If the seller transfers the ShopNFT before the
   order completes, revenue still routes to the **original** shopId.
   Shareholders are insulated from operator transfers on in-flight
   orders.
4. **No fee on refund** — `cancelOrder` and `resolveDispute(refundBuyer=true)`
   return 100 % of the order amount to the buyer. The distributor is
   never called on these paths.
5. **Pull-based claims** — no for-each loop over shareholders on
   deposit. Deposit cost is O(1) in holder count and O(K) in number of
   distinct payment tokens previously deposited to the shop.
6. **No cross-contract authority leakage** — v3.3 contracts never
   write to v3.2 state. v3.2 state never references v3.3 contracts.

## ShareMarket (K.4)

ShareMarket is a permissionless, approval-based listing book for
`ShopShares`. Sellers don't escrow their shares — they keep them in
their wallet and call `setApprovalForAll(market, true)` once. Each
listing is fixed-amount / fixed-price / all-or-nothing.

### Why approval, not escrow

Escrowing shares into the market for the lifetime of a listing would
hand the market the corresponding revenue-distribution rights — the
market would receive the `settle` callback on every share movement,
and the listing seller would lose accruals while the listing is open.
Either we'd need to teach the market to forward those accruals back
to the lister (complex bookkeeping), or sellers would silently lose
revenue. Approval-based listings sidestep this entirely: the
distributor sees the seller as the holder until the fill tx, at which
point it sees the buyer.

Trade-off: **phantom listings** are possible. A seller can transfer
shares away or revoke approval after listing. Fills then revert
inside `IERC1155.safeTransferFrom` (`ERC1155InsufficientBalance` or
`ERC1155MissingApprovalForAll`). The buyer is no worse off than if
the listing had never existed — they pay no gas beyond the failed
transaction. The K.5 indexer surface will flag listings whose seller
balance dropped below the listed amount so the frontend can hide
them.

### Lifecycle

```
seller                                            market state
──────                                            ────────────
setApprovalForAll(market, true)            ←──── once per seller
createListing(shopId, amount, token, price) ───→  Listing.Active
                                            ←──── ListingCreated event

buyer
─────
fillListing(id, msg.value=price for native)
   pre-flight: status == Active                 (CEI: state flips first)
   pay seller (native call OR safeTransferFrom)
   transfer shares via shopShares.safeTransferFrom
                                            ←──── ListingFilled event
                                                  Listing.Filled

seller
──────
cancelListing(id) — always allowed, even when paused
                                            ←──── ListingCancelled event
                                                  Listing.Cancelled
```

### Out of scope (deferred)

- **Partial fills.** Multi-tier sellers post multiple listings. K.4b.
- **Platform fee.** Payments go straight from buyer to seller.
  Adding a fee is a one-branch change in `fillListing` plus a setter.
- **paymentToken allowlist.** Buyers vet the listing's paymentToken
  themselves — same risk model as vetting the seller / price.
- **Reservation / locking.** A listing is racy in the sense that two
  buyers can both try to fill it; the first tx wins, the second sees
  `ListingNotActive(Filled)`.

## v3.2 vs v3.3

| | v3.2 marketplace | v3.3 marketplace |
|---|---|---|
| Status | shipped, stable, used in I.3 / I.4 / I.5 | testnet draft (K.3b) |
| EIP-712 domain | `ChainUsEscrowERC20` / `3.2` | `ChainUsEscrowV3_3` / `3.3` — signatures DON'T cross |
| `Order.shopId` | n/a | uint256 snapshot at create time |
| Fee on completion | none | `(amount × feeRateBps) / 10 000`, default 1 %, ≤ 10 % |
| Fee destination | n/a | `RevenueDistributor` via `deposit` / `depositERC20` |
| Seller requirement | any address | `ShopNFT.shopIdOf(seller) != 0` (else `NoShopAssociated`) |
| Kleros adapter | yes (K.H.3) | **not yet** — `resolveDispute` stays `onlyOwner` for K.3b |

## What's NOT in K.3b (deferred)

- **Kleros adapter for v3.3.** v3.3 reuses v3.2's `onlyOwner`
  resolveDispute pathway. Wiring the K.H.3 adapter to v3.3 is K.3c (or
  later).
- **v3.3 indexer.** No `OnChainOrderV3_3` table yet. K.5 will add it
  alongside a Distributor / Shares event mirror.
- **Frontend.** No `/shop/{id}` page, no share-market UI, no
  shareholder dashboard. K.5 / K.6.
- **Mainnet.** Audit + share-tokenisation legal review must come first.
  Every contract still carries the `WIP-DRAFT — NOT AUDITED — DO NOT
  DEPLOY TO MAINNET` header in its NatSpec.

## Roadmap pointers

- **K.4** — ✅ shipped. ShareMarket address above.
- **K.5** — v3.3 indexer (OnChainOrderV3_3, ShopNFT events, Shares
  events, Distributor events, ShareMarket listings) + metadata server.
- **K.6** — Frontend: `/shop/{id}` page, share-market UI, shareholder
  dashboard (cumulative earnings, pending claims, claim button).
