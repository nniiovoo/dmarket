import { test } from "node:test";
import assert from "node:assert";

import {
  buildPaymentAuthDraft,
  PAYMENT_AUTH_DOMAIN_NAME,
  PAYMENT_AUTH_DOMAIN_VERSION
} from "./draftOrder";

const BUYER = "0xAAaaaAaAaAAaAAaAAaAAaAAaAAaAAaAAaAAa1111";
const SELLER = "0xBbBBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbB2222";
const PAYMENT_TOKEN = "0xCccCCcCcccCcCccccCcccCcCccCccCcCcCcc3333";
const MARKETPLACE = "0xDddDddddDDddDDDDddDddDdDddDddddDdDdd4444";

test("buildPaymentAuthDraft maps all fields and applies TTL deterministically", async () => {
  const fixedNow = 1_700_000_000_000;
  const draft = await buildPaymentAuthDraft({
    buyer: BUYER,
    seller: SELLER,
    paymentToken: PAYMENT_TOKEN,
    productId: 42n,
    amount: 1_000_000n,
    chainId: 421614,
    marketplaceAddress: MARKETPLACE,
    ttlSeconds: 1800,
    readNonce: async () => 7n,
    now: () => fixedNow
  });

  assert.strictEqual(draft.domain.name, PAYMENT_AUTH_DOMAIN_NAME);
  assert.strictEqual(draft.domain.version, PAYMENT_AUTH_DOMAIN_VERSION);
  assert.strictEqual(draft.domain.chainId, 421614);
  assert.strictEqual(draft.domain.verifyingContract.toLowerCase(), MARKETPLACE.toLowerCase());
  assert.strictEqual(draft.primaryType, "PaymentAuth");
  assert.strictEqual(draft.message.buyer.toLowerCase(), BUYER.toLowerCase());
  assert.strictEqual(draft.message.seller.toLowerCase(), SELLER.toLowerCase());
  assert.strictEqual(draft.message.paymentToken.toLowerCase(), PAYMENT_TOKEN.toLowerCase());
  assert.strictEqual(draft.message.productId, "42");
  assert.strictEqual(draft.message.amount, "1000000");
  assert.strictEqual(draft.message.nonce, "7");
  // deadline = floor(now/1000) + ttl = 1_700_000_000 + 1800
  assert.strictEqual(draft.message.deadline, String(1_700_000_000 + 1800));
});

test("buildPaymentAuthDraft propagates on-chain nonce from injected reader", async () => {
  const calls: Array<{ chainId: number; marketplace: string; buyer: string }> = [];
  const draft = await buildPaymentAuthDraft({
    buyer: BUYER,
    seller: SELLER,
    paymentToken: PAYMENT_TOKEN,
    productId: 1n,
    amount: 1n,
    chainId: 421614,
    marketplaceAddress: MARKETPLACE,
    ttlSeconds: 60,
    readNonce: async (chainId, marketplace, buyer) => {
      calls.push({ chainId, marketplace, buyer });
      return 99n;
    },
    now: () => 0
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0]!.chainId, 421614);
  assert.strictEqual(calls[0]!.marketplace.toLowerCase(), MARKETPLACE.toLowerCase());
  assert.strictEqual(calls[0]!.buyer.toLowerCase(), BUYER.toLowerCase());
  assert.strictEqual(draft.message.nonce, "99");
});
