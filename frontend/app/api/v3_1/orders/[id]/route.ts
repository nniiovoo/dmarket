// V3.1 order detail API. DB-first; falls back to a direct on-chain read
// against the V3.1 marketplace when the indexer hasn't seen the order yet
// (common immediately after a relayer submits createAndPayWithAuth).
//
// Returns the same shape as the V3 OnChainOrder API so the V3.1 page can
// share rendering helpers.

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import { arbitrumSepolia } from "viem/chains";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { escrowMarketplaceV3_1Abi, getV3_1ContractAddresses } from "@/lib/contracts";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const STATUS_NAMES = [
  "Created",
  "Paid",
  "Shipped",
  "Completed",
  "Cancelled",
  "Disputed",
  "Refunded"
] as const;

type RouteContext = {
  params: Promise<{ id: string }>;
};

function parseQuery(req: NextRequest) {
  const chainIdRaw = req.nextUrl.searchParams.get("chainId");
  const chainId = chainIdRaw ? Number(chainIdRaw) : NaN;

  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { error: "Missing or invalid chainId query param" as const };
  }

  return { chainId };
}

function timestampToIso(value: bigint | null): string | null {
  if (value === null || value === 0n) return null;
  return new Date(Number(value) * 1000).toISOString();
}

function rpcUrlForChain(chainId: number): string | undefined {
  if (chainId === arbitrumSepolia.id) {
    return process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL;
  }
  return undefined;
}

export const GET = withErrorBoundary(async (req: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const onChainOrderId = id;

  if (!/^[1-9]\d*$/.test(onChainOrderId)) {
    return NextResponse.json({ error: "Invalid order id" }, { status: 400 });
  }

  const q = parseQuery(req);
  if ("error" in q) {
    return NextResponse.json({ error: q.error }, { status: 400 });
  }

  const { chainId } = q;

  // 1. DB hit — indexer has already seen it.
  const dbRow = await prisma.onChainOrderV3_1.findUnique({
    where: { chainId_onChainOrderId: { chainId, onChainOrderId } }
  });

  if (dbRow) {
    return NextResponse.json({
      source: "indexer",
      chainId: dbRow.chainId,
      onChainOrderId: dbRow.onChainOrderId,
      buyer: dbRow.buyer,
      seller: dbRow.seller,
      productId: dbRow.productId,
      amountWei: dbRow.amountWei,
      status: dbRow.status,
      createdAt: dbRow.createdAt?.toISOString() ?? null,
      paidAt: dbRow.paidAt?.toISOString() ?? null,
      shippedAt: dbRow.shippedAt?.toISOString() ?? null,
      completedAt: dbRow.completedAt?.toISOString() ?? null,
      refundedAt: dbRow.refundedAt?.toISOString() ?? null,
      disputedAt: dbRow.disputedAt?.toISOString() ?? null,
      carrier: dbRow.carrier,
      trackingNumber: dbRow.trackingNumber,
      trackingUrl: dbRow.trackingUrl,
      shippingNote: dbRow.shippingNote,
      shippingUpdatedAt: dbRow.shippingUpdatedAt?.toISOString() ?? null
    });
  }

  // 2. Fallback to on-chain read. Useful right after createAndPayWithAuth
  // when the indexer hasn't ticked yet.
  const contracts = getV3_1ContractAddresses(chainId);
  const rpcUrl = rpcUrlForChain(chainId);

  if (!contracts || !rpcUrl) {
    return NextResponse.json(
      { error: "V3.1 not configured on this chain" },
      { status: 404 }
    );
  }

  try {
    const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
    const order = (await client.readContract({
      address: contracts.marketplace as Address,
      abi: escrowMarketplaceV3_1Abi,
      functionName: "getOrder",
      args: [BigInt(onChainOrderId)]
    })) as {
      id: bigint;
      buyer: Address;
      status: number;
      createdAt: bigint;
      seller: Address;
      paidAt: bigint;
      productId: bigint;
      amount: bigint;
      shippedAt: bigint;
      completedAt: bigint;
      deliveredAt: bigint;
      disputedAt: bigint;
    };

    return NextResponse.json({
      source: "chain",
      chainId,
      onChainOrderId,
      buyer: order.buyer.toLowerCase(),
      seller: order.seller.toLowerCase(),
      productId: order.productId.toString(),
      amountWei: order.amount.toString(),
      status: STATUS_NAMES[order.status] ?? "Unknown",
      createdAt: timestampToIso(order.createdAt),
      paidAt: timestampToIso(order.paidAt),
      shippedAt: timestampToIso(order.shippedAt),
      completedAt: timestampToIso(order.completedAt),
      refundedAt: null,
      disputedAt: timestampToIso(order.disputedAt),
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shippingNote: null,
      shippingUpdatedAt: null
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "On-chain read failed";
    return NextResponse.json({ error: `On-chain read failed: ${message}` }, { status: 404 });
  }
});
