import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { verifySellerSignature } from "@/lib/auth";
import { isBlocked } from "@/lib/blacklist";
import { prisma } from "@/lib/db";
import { loadBlacklistFacts } from "@/lib/risk/integrations/blacklist";
import { productCreateSchema, productListQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Product = { sellerAddress: string; [key: string]: unknown };

/** Filter products by blacklist. Total is post-filter — buyer never sees blacklisted listings exist. */
export async function filterByBlacklist<T extends Product>(
  products: T[],
  loadFacts: typeof loadBlacklistFacts = loadBlacklistFacts
): Promise<{ filtered: T[]; total: number }> {
  const uniqueSellers = Array.from(new Set(products.map((p) => p.sellerAddress)));
  const { blacklisted } = await loadFacts(uniqueSellers);
  const blockedSet = new Set(blacklisted);
  const filtered = products.filter((p) => !blockedSet.has(p.sellerAddress.toLowerCase()));
  return { filtered, total: filtered.length };
}

/** Gate: returns 403 response if seller is blocked, else null. */
export async function blacklistGate(
  sellerAddress: string,
  checkBlocked: typeof isBlocked = isBlocked
): Promise<NextResponse | null> {
  const blocked = await checkBlocked(sellerAddress);
  if (blocked) {
    // Generic 403 — do not leak blacklist membership.
    return NextResponse.json({ error: "Seller is not permitted to list products" }, { status: 403 });
  }
  return null;
}

export const GET = withErrorBoundary(async (request: NextRequest) => {
  const parsed = productListQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));

  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const { chainId, seller, status, limit, offset } = parsed.data;
  const where = {
    ...(chainId !== undefined ? { chainId } : {}),
    ...(seller !== undefined ? { sellerAddress: seller } : {}),
    status
  };

  const products = await prisma.product.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset
  });

  // Post-filter by blacklist. Total reflects what the buyer can see — correct UX.
  const { filtered, total } = await filterByBlacklist(products);

  return NextResponse.json({ products: filtered, total });
});

export const POST = withErrorBoundary(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const data = productCreateSchema.parse(body);
    const auth = await verifySellerSignature(
      {
        sellerAddress: data.sellerAddress,
        signature: data.signature as `0x${string}`,
        signedMessage: data.signedMessage
      },
      "ChainUs:CreateProduct:"
    );

    if (!auth.ok) {
      return NextResponse.json({ error: "Signature verification failed", reason: auth.reason }, { status: 401 });
    }

    const gate = await blacklistGate(data.sellerAddress);
    if (gate) return gate;

    const product = await prisma.product.create({
      data: {
        sellerAddress: data.sellerAddress,
        name: data.name,
        description: data.description,
        priceWei: data.priceWei,
        chainId: data.chainId,
        imageUrl: data.imageUrl,
        status: "active"
      }
    });

    return NextResponse.json(product, { status: 201 });
  } catch (caught) {
    if (caught instanceof ZodError) {
      return validationError(caught);
    }

    return NextResponse.json({ error: "Failed to create product" }, { status: 500 });
  }
});

function validationError(error: ZodError) {
  return NextResponse.json({ error: "Validation failed", details: error.flatten() }, { status: 400 });
}
