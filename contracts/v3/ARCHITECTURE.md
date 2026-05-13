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
