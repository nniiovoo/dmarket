// End-to-end smoke for Phase I.3 — public AI draft-order flow.
//
// What this exercises:
//   1. Signs an OAuth bearer JWT directly (skips the browser SIWE handoff
//      since this is a CLI smoke).
//   2. POSTs /api/ai/draft-order with that bearer and a real productId on
//      Arbitrum Sepolia. Asserts the response carries a valid EIP-712
//      payload + sign URL.
//   3. Recovers the EIP-712 signer locally to confirm the payload matches
//      what `createAndPayWithAuth` will compute on-chain.
//   4. Optionally submits the transaction (skipped by default to keep the
//      smoke gas-free; pass --submit to opt in).
//
// Required env:
//   OAUTH_JWT_SECRET          — same secret the server reads
//   PRIVATE_KEY               — buyer key (the one our smoke is "acting as")
//   ARBITRUM_SEPOLIA_RPC_URL  — for the on-chain submit path
//   AI_SMOKE_BASE_URL         — defaults to http://localhost:3000
//   AI_SMOKE_PRODUCT_ID       — defaults to 1
//
// Usage:
//   cd frontend
//   npx tsx scripts/smokeAIDraftOrder.ts            # off-chain validation only
//   npx tsx scripts/smokeAIDraftOrder.ts --submit   # also sends createAndPayWithAuth

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });
dotenvConfig({ path: "../.env" });

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  recoverTypedDataAddress,
  type Address
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

import { signOAuthJwt } from "../lib/ai/auth";
import {
  PAYMENT_AUTH_DOMAIN_NAME,
  PAYMENT_AUTH_DOMAIN_VERSION,
  PAYMENT_AUTH_TYPES
} from "../lib/ai/draftOrder";
import { escrowMarketplaceERC20Abi } from "../lib/contractsV3_2";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const baseUrl = process.env.AI_SMOKE_BASE_URL ?? "http://localhost:3000";
  const productId = Number(process.env.AI_SMOKE_PRODUCT_ID ?? "1");
  const buyerKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!buyerKey) fail("PRIVATE_KEY is not set");

  const submit = process.argv.includes("--submit");

  if (!process.env.OAUTH_JWT_SECRET || process.env.OAUTH_JWT_SECRET.length < 16) {
    fail("OAUTH_JWT_SECRET is not set or too short");
  }

  const buyer = privateKeyToAccount(buyerKey);
  console.log(`Buyer = ${buyer.address}`);

  // 1) Sign a bearer for this buyer.
  const bearer = signOAuthJwt({
    sub: buyer.address.toLowerCase(),
    cid: "smoke",
    exp: Math.floor(Date.now() / 1000) + 60 * 10
  });
  console.log("✓ Issued bearer JWT (10 min ttl)");

  // 2) Call /api/ai/draft-order.
  const draftRes = await fetch(`${baseUrl}/api/ai/draft-order`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`
    },
    body: JSON.stringify({ productId })
  });
  if (!draftRes.ok) {
    const body = await draftRes.text();
    fail(`/api/ai/draft-order returned ${draftRes.status}: ${body}`);
  }
  const draft = (await draftRes.json()) as {
    draftId: string;
    signUrl: string;
    payload: {
      domain: { name: string; version: string; chainId: number; verifyingContract: Address };
      types: typeof PAYMENT_AUTH_TYPES;
      primaryType: "PaymentAuth";
      message: Record<string, string>;
    };
    product: { id: number; sellerAddress: string; priceWei: string; chainId: number };
    token: { symbol: string; address: Address; decimals: number; amount: string };
  };
  console.log(`✓ Got draft ${draft.draftId} (sign URL: ${draft.signUrl})`);
  console.log(`  product=${draft.product.id} seller=${draft.product.sellerAddress}`);
  console.log(`  token=${draft.token.symbol} amount=${draft.token.amount}`);

  // 3) Domain sanity-check.
  if (draft.payload.domain.name !== PAYMENT_AUTH_DOMAIN_NAME) {
    fail(`Domain name mismatch: ${draft.payload.domain.name}`);
  }
  if (draft.payload.domain.version !== PAYMENT_AUTH_DOMAIN_VERSION) {
    fail(`Domain version mismatch: ${draft.payload.domain.version}`);
  }
  if (draft.payload.domain.chainId !== arbitrumSepolia.id) {
    fail(`Domain chainId mismatch: ${draft.payload.domain.chainId}`);
  }
  console.log("✓ EIP-712 domain matches v3.2 contract");

  // 4) Sign locally and recover.
  const message = {
    buyer: getAddress(draft.payload.message.buyer!),
    seller: getAddress(draft.payload.message.seller!),
    paymentToken: getAddress(draft.payload.message.paymentToken!),
    productId: BigInt(draft.payload.message.productId!),
    amount: BigInt(draft.payload.message.amount!),
    nonce: BigInt(draft.payload.message.nonce!),
    deadline: BigInt(draft.payload.message.deadline!)
  };

  const signature = await buyer.signTypedData({
    domain: draft.payload.domain,
    types: PAYMENT_AUTH_TYPES,
    primaryType: "PaymentAuth",
    message
  });

  const recovered = await recoverTypedDataAddress({
    domain: draft.payload.domain,
    types: PAYMENT_AUTH_TYPES,
    primaryType: "PaymentAuth",
    message,
    signature
  });
  if (recovered.toLowerCase() !== buyer.address.toLowerCase()) {
    fail(`Local signer recovery mismatch: ${recovered} vs ${buyer.address}`);
  }
  console.log(`✓ Local EIP-712 signature recovers to buyer (${recovered.slice(0, 10)}…)`);

  if (!submit) {
    console.log("\nSkipping on-chain submit (pass --submit to actually call createAndPayWithAuth).");
    return;
  }

  // 5) On-chain submit.
  const rpcUrl =
    process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL;
  if (!rpcUrl) fail("ARBITRUM_SEPOLIA_RPC_URL is not set");

  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account: buyer,
    chain: arbitrumSepolia,
    transport: http(rpcUrl)
  });

  console.log(`Submitting createAndPayWithAuth on ${draft.payload.domain.verifyingContract}…`);
  const hash = await walletClient.writeContract({
    address: draft.payload.domain.verifyingContract,
    abi: escrowMarketplaceERC20Abi,
    functionName: "createAndPayWithAuth",
    args: [message, signature]
  });
  console.log(`  tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`tx reverted (${hash})`);
  console.log(`✓ Tx confirmed in block ${receipt.blockNumber}`);

  // 6) mark-signed.
  const markRes = await fetch(`${baseUrl}/api/ai/draft-order/${draft.draftId}/mark-signed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash: hash, orderId: null })
  });
  if (!markRes.ok) fail(`mark-signed failed: ${markRes.status}`);
  console.log("✓ Draft marked signed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
