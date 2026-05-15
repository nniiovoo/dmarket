// POST /api/ai/draft-order — public, auth'd unsigned-PaymentAuth issuer.
//
// Body:
//   { productId: number, paymentTokenSymbol?: "mUSD" }
//
// Response:
//   {
//     draftId, signUrl, expiresAt,
//     payload: { domain, types, primaryType, message },
//     product: { id, name, sellerAddress, priceWei, chainId },
//     token:   { symbol, address, decimals, amount }
//   }
//
// The agent calls this after the buyer has picked a candidate from
// /api/ai/search. The response carries everything /sign/[draftId] needs
// to feed `useSignTypedData` and `useWriteContract.createAndPayWithAuth`.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { getAddress, type Address, isAddress } from "viem";
import { arbitrumSepolia } from "viem/chains";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { requireAuth } from "@/lib/ai/auth";
import { buildPaymentAuthDraft } from "@/lib/ai/draftOrder";
import { getAcceptedTokens, getV3_2ContractAddresses } from "@/lib/contractsV3_2";
import { convertEthWeiToToken } from "@/lib/payment/tokenAmount";
import { prisma } from "@/lib/db";
import { createRateLimiter } from "@/lib/rateLimit";
import { loadBlacklistFacts } from "@/lib/risk/integrations/blacklist";

export const dynamic = "force-dynamic";

const DRAFT_TTL_SECONDS = 30 * 60;

const bodySchema = z.object({
  productId: z.number().int().positive(),
  paymentTokenSymbol: z.string().min(1).max(16).optional(),
  // Optional defensive field: caller can pass the price they saw at search
  // time. If the on-chain product has since been edited, we reject with
  // 409 so the agent re-fetches before showing the buyer a sign URL.
  expectedPriceWei: z.string().regex(/^\d+$/).optional()
});

const limiter = createRateLimiter({
  name: "ai-draft-order",
  max: 10,
  windowMs: 60 * 1000
});

export const POST = withErrorBoundary(async (request: NextRequest) => {
  const requestId = randomUUID();

  const auth = await requireAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error, reason: auth.reason, requestId }, { status: auth.status });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json", requestId }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", details: parsed.error.flatten(), requestId },
      { status: 400 }
    );
  }

  const bucketKey = auth.caller.address.toLowerCase();
  const limit = await limiter.check(bucketKey);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limit_exceeded", resetAt: limit.resetAt, requestId },
      { status: 429 }
    );
  }

  const product = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
  if (!product) {
    return NextResponse.json({ error: "product_not_found", requestId }, { status: 404 });
  }
  if (product.status !== "active") {
    return NextResponse.json({ error: "product_not_active", requestId }, { status: 410 });
  }
  if (parsed.data.expectedPriceWei && parsed.data.expectedPriceWei !== product.priceWei) {
    return NextResponse.json(
      {
        error: "price_drift",
        currentPriceWei: product.priceWei,
        sawPriceWei: parsed.data.expectedPriceWei,
        requestId
      },
      { status: 409 }
    );
  }

  // Block buyer == seller and blacklisted sellers right here. The recommend
  // pipeline already filters blacklisted sellers out of search results, but
  // the agent could call /draft-order with any productId, so we re-check.
  if (!isAddress(product.sellerAddress)) {
    return NextResponse.json({ error: "invalid_product_seller", requestId }, { status: 500 });
  }
  if (product.sellerAddress.toLowerCase() === bucketKey) {
    return NextResponse.json({ error: "buyer_is_seller", requestId }, { status: 400 });
  }
  const { blacklisted } = await loadBlacklistFacts([product.sellerAddress, auth.caller.address]);
  if (blacklisted.length > 0) {
    return NextResponse.json({ error: "blocked_party", requestId }, { status: 403 });
  }

  // v3.2 marketplace + accepted token resolution. MVP only supports
  // Arbitrum Sepolia + mUSD; product.chainId must match — the listings can
  // exist on legacy chains but only the v3.2 lane can be drafted here.
  if (product.chainId !== arbitrumSepolia.id) {
    return NextResponse.json(
      { error: "unsupported_chain", chainId: product.chainId, requestId },
      { status: 400 }
    );
  }
  const v32 = getV3_2ContractAddresses(product.chainId);
  if (!v32) {
    return NextResponse.json({ error: "v3_2_not_configured", requestId }, { status: 503 });
  }
  const tokens = getAcceptedTokens(product.chainId);
  if (tokens.length === 0) {
    return NextResponse.json({ error: "no_accepted_tokens", requestId }, { status: 503 });
  }
  const desired = parsed.data.paymentTokenSymbol;
  const token = desired ? tokens.find((t) => t.symbol === desired) ?? null : tokens[0]!;
  if (!token) {
    return NextResponse.json(
      { error: "payment_token_not_supported", requested: desired, supported: tokens.map((t) => t.symbol), requestId },
      { status: 400 }
    );
  }

  const priceWei = BigInt(product.priceWei);
  const amount = convertEthWeiToToken(priceWei, token);

  const buyer = getAddress(auth.caller.address) as Address;
  const seller = getAddress(product.sellerAddress) as Address;
  const productIdBig = BigInt(product.id);

  let draft;
  try {
    draft = await buildPaymentAuthDraft({
      buyer,
      seller,
      paymentToken: token.address,
      productId: productIdBig,
      amount,
      chainId: product.chainId,
      marketplaceAddress: v32.marketplace,
      ttlSeconds: DRAFT_TTL_SECONDS
    });
  } catch (err) {
    return NextResponse.json(
      { error: "nonce_read_failed", reason: err instanceof Error ? err.message : String(err), requestId },
      { status: 503 }
    );
  }

  const draftId = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Number(draft.message.deadline) * 1000);

  await prisma.draftOrder.create({
    data: {
      id: draftId,
      buyer: buyer.toLowerCase(),
      seller,
      paymentToken: token.address,
      productId: productIdBig.toString(),
      amount: amount.toString(),
      nonce: draft.message.nonce,
      deadline: expiresAt,
      chainId: product.chainId,
      marketplaceAddress: v32.marketplace,
      productNameSnapshot: product.name,
      expiresAt
    }
  });

  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? request.nextUrl.origin;
  const signUrl = `${origin}/sign/${draftId}`;

  return NextResponse.json({
    draftId,
    signUrl,
    expiresAt: expiresAt.toISOString(),
    payload: draft,
    product: {
      id: product.id,
      name: product.name,
      sellerAddress: product.sellerAddress,
      priceWei: product.priceWei,
      chainId: product.chainId
    },
    token: {
      symbol: token.symbol,
      address: token.address,
      decimals: token.decimals,
      amount: amount.toString()
    },
    caller: { address: auth.caller.address, via: auth.caller.via },
    requestId
  });
});
