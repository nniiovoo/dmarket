# ChainUs v3 Escrow Architecture

v3 is a new deployment line. It does not modify v2 marketplace or vault contracts, and old orders remain on v2.
New orders can move to v3 when the product and frontend are ready.

## Contracts

- `EscrowVaultV3`: custody-only vault. It accepts ETH only from its paired marketplace, records locked funds by `orderId`, and releases funds only when `EscrowMarketplaceV3` instructs it.
- `EscrowMarketplaceV3`: order state machine plus Chainlink Functions delivery checks. It preserves the v2 seven-status lifecycle and adds `deliveredAt`.

The vault is one-to-one with the marketplace. `setMarketplace` is owner-only and can be called exactly once.

## Why Chainlink Functions

Shipping delivery status is off-chain data. v2 requires the buyer to call `confirmReceived`, so funds can remain stuck when a buyer disappears after delivery.
v3 uses Chainlink Functions as an oracle layer: the marketplace sends an order ID to the DON, the JavaScript source looks up the tracking number from the ChainUs backend, queries 17track, and returns:

```solidity
abi.encode(bool delivered, uint64 deliveredTimestamp)
```

The contract records delivery only when the DON reports `delivered == true`.

## Auto-Release Flow

1. Buyer creates and pays an order.
2. Seller marks the order as shipped.
3. Anyone can call `requestDelivery(orderId)` while the order is shipped.
4. Chainlink Functions calls back with delivery status.
5. If delivered, `deliveredAt` is written and `DeliveryRecorded` is emitted.
6. Buyer can still manually call `confirmReceived` at any time while status is `Shipped`.
7. If no dispute is opened, anyone can call `autoConfirmAfterDelivery(orderId)` after `deliveredAt + 10 days`.
8. The marketplace completes the order and the vault releases funds to the seller.

If buyer or seller opens a dispute before auto-confirmation, status becomes `Disputed` and auto-release is blocked. Owner dispute resolution remains the escalation path.

## Production Ownership Setup

Before any mainnet deployment, ownership of `EscrowMarketplaceV3` MUST be
transferred to a `TimelockController`, which in turn is administered by a
Gnosis Safe multisig. EOA ownership is acceptable on testnet only.

Rationale: `resolveDispute`, `ownerEmergencyRefund`, `pause`, and the
Chainlink Functions config/update functions (`commitRequestSource` is the
most sensitive — it can re-write the oracle JS after the proposal delay) are all onlyOwner.
An EOA owner is a single key compromise away from draining every escrowed
order. The timelock gives operators and the public a delay window in which
malicious or accidental owner actions can be observed (via the
`SubscriptionIdUpdated` / `DonIdUpdated` / `CallbackGasLimitUpdated` /
`RequestSourceUpdated` / `EncryptedSecretsReferenceUpdated` events) and
cancelled (`TimelockController.cancel`) by the multisig.

Recommended parameters:
- Timelock delay: 48 hours minimum on mainnet
- Multisig threshold: at least 2-of-3
- Multisig: PROPOSER + EXECUTOR; admin = address(0) (timelock self-administers)

Deployment: `scripts/deployV3WithTimelock.ts`.

Note: `EscrowVaultV3.owner` is `immutable` and only used for the one-shot
`setMarketplace`. After that single call it has no further authority, so
there's no need to migrate vault ownership.

## Oracle Source Hygiene

`chainlink/functions/deliveryStatus.js` has two code paths:

1. **Production path** — `TRACKING_LOOKUP_URL` is set. The DON calls the
   ChainUs backend to resolve `orderId` → `{trackingNumber, carrier}`.
   Every order has its own tracking number.

2. **Test fallback** — `TRACKING_LOOKUP_URL` is unset and
   `ALLOW_TEST_FALLBACK=1` is explicitly set in DON secrets. The DON uses
   a single shared `TEST_TRACKING_NUMBER` for every order. **This is for
   testnet smoke tests only.** If a real tracking number happens to show
   `delivered`, every Shipped order on the contract becomes auto-confirmable
   after 10 days.

`scripts/configureV3Functions.ts` refuses to upload fallback secrets to any
mainnet network. If you ever need a mainnet hotfix that uses the fallback,
you'd need to remove the check explicitly — by design, you cannot do it
by accident.

## Request Source Update Protocol

Updating `requestSource` (the Chainlink Functions JavaScript) is a two-step
commit-reveal flow with a 7-day on-chain delay:

1. **Propose** — owner calls `proposeRequestSource(newSource)`. The contract
   stores `keccak256(newSource)` and `block.timestamp + 7 days`, emits
   `RequestSourceProposed(hash, length, readyAt)`. The full source is in the
   transaction calldata so monitors can fetch it for review.
2. **Wait** — 7 days minimum on-chain delay. Combined with the timelock
   owner (48h), the total review window for any proposed JS change is
   **9 days**. Cancel anytime via `cancelPendingRequestSource()`.
3. **Commit** — owner re-supplies the same source via `commitRequestSource(newSource)`.
   The contract verifies the hash matches and the delay has elapsed, then
   overwrites `requestSource` and emits `RequestSourceUpdated(hash, length)`.

Only one pending proposal can exist at a time. To replace a proposal,
call `cancelPendingRequestSource()` first.

The initial `requestSource` is set at deploy time via the constructor
argument and is not subject to the commit-reveal delay — only post-deploy
updates are.

## Dispute & Emergency Refund Time Windows

Owner privileges over escrowed funds are gated by on-chain delays as a
defense-in-depth complement to the timelocked multisig owner:

- **`resolveDispute(orderId, refundBuyer)`** — requires
  `block.timestamp >= disputedAt + 3 days`. The waiting period gives
  buyer and seller time to provide off-chain evidence and gives the
  public time to observe (and the multisig time to cancel) malicious
  resolution attempts. Combined with the 48-hour timelock, an unjust
  dispute resolution has at least a 5-day public review window.

- **`ownerEmergencyRefund(orderId)`** — only callable on stale orders:
  - `Paid` with `block.timestamp >= paidAt + 30 days` (seller never shipped)
  - `Shipped` with `block.timestamp >= shippedAt + 60 days` (delivery never confirmed)
  `Disputed` orders cannot be emergency-refunded — they must go through
  `resolveDispute`. This removes the owner's ability to instantly drain
  escrow on any active order.

These windows do not protect against a compromised owner *and* compromised
timelock simultaneously, but they ensure that any drainage attempt has a
multi-day public footprint that the community (or a separate guardian
contract, if added later) can react to.
