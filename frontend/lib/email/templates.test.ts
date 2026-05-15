import { test } from "node:test";
import assert from "node:assert";

import { renderNotification } from "./templates";
import type { ApiOrder } from "../orders";

function buildOrder(overrides: Partial<ApiOrder> = {}): ApiOrder {
  return {
    chainId: 421614,
    onChainOrderId: "42",
    buyer: "0xaaaa000000000000000000000000000000000001",
    seller: "0xbbbb000000000000000000000000000000000002",
    productId: "1",
    amountWei: "1000000000000000000",
    status: "Shipped",
    createdAt: "2026-01-01T00:00:00.000Z",
    paidAt: "2026-01-01T01:00:00.000Z",
    shippedAt: "2026-01-01T02:00:00.000Z",
    completedAt: null,
    refundedAt: null,
    disputedAt: null,
    carrier: "DHL",
    trackingNumber: "1234567890",
    trackingUrl: "https://example.com/track/1234567890",
    shippingNote: null,
    shippingUpdatedAt: "2026-01-01T02:00:00.000Z",
    product: null,
    lastTxHash: "0x" + "a".repeat(64),
    marketplaceVersion: "v3",
    ...overrides
  };
}

test("renderNotification HTML includes the chain explorer tx URL for the order's lastTxHash", () => {
  const order = buildOrder();
  const template = renderNotification("OrderShipped", order);
  const expectedUrl = `https://sepolia.arbiscan.io/tx/${order.lastTxHash}`;

  assert.ok(
    template.html.includes(expectedUrl),
    `expected HTML to include ${expectedUrl}\n--- HTML ---\n${template.html}`
  );
});

test("renderNotification plaintext also includes the explorer tx URL", () => {
  const order = buildOrder();
  const template = renderNotification("OrderShipped", order);
  const expectedUrl = `https://sepolia.arbiscan.io/tx/${order.lastTxHash}`;

  assert.ok(
    template.text.includes(expectedUrl),
    `expected text to include ${expectedUrl}\n--- TEXT ---\n${template.text}`
  );
});

test("renderNotification omits the explorer row when lastTxHash is null and never emits /tx/null", () => {
  const order = buildOrder({ lastTxHash: null });
  const template = renderNotification("OrderShipped", order);

  assert.ok(
    !/\/tx\/(null|undefined)/.test(template.html),
    `HTML must not link to a placeholder tx URL:\n${template.html}`
  );
  assert.ok(
    !/\/tx\/(null|undefined)/.test(template.text),
    `text must not link to a placeholder tx URL:\n${template.text}`
  );
});
