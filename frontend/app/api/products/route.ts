import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { verifySellerSignature } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { productCreateSchema, productListQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
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

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset
    }),
    prisma.product.count({ where })
  ]);

  return NextResponse.json({ products, total });
}

export async function POST(request: NextRequest) {
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
}

function validationError(error: ZodError) {
  return NextResponse.json({ error: "Validation failed", details: error.flatten() }, { status: 400 });
}
