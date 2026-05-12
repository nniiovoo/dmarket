import { NextRequest, NextResponse } from "next/server";
import { ZodError, z } from "zod";

import { verifySellerSignature } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { addressSchema, productUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const deleteSchema = z.object({
  sellerAddress: addressSchema,
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid signature"),
  signedMessage: z.string()
});

export async function GET(_request: NextRequest, context: RouteContext) {
  const id = await getProductId(context);

  if (id === undefined) {
    return NextResponse.json({ error: "Invalid product id" }, { status: 400 });
  }

  const product = await prisma.product.findUnique({ where: { id } });

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  return NextResponse.json(product);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const id = await getProductId(context);

    if (id === undefined) {
      return NextResponse.json({ error: "Invalid product id" }, { status: 400 });
    }

    const existing = await prisma.product.findUnique({ where: { id } });

    if (!existing) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const body = await request.json();
    const data = productUpdateSchema.parse(body);
    const auth = await verifySellerSignature(
      {
        sellerAddress: data.sellerAddress,
        signature: data.signature as `0x${string}`,
        signedMessage: data.signedMessage
      },
      `ChainUs:UpdateProduct:${id}:`
    );

    if (!auth.ok) {
      return NextResponse.json({ error: "Signature verification failed", reason: auth.reason }, { status: 401 });
    }

    if (existing.sellerAddress !== data.sellerAddress) {
      return NextResponse.json({ error: "Only product seller can update this product" }, { status: 403 });
    }

    const product = await prisma.product.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.priceWei !== undefined ? { priceWei: data.priceWei } : {}),
        ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl } : {}),
        ...(data.status !== undefined ? { status: data.status } : {})
      }
    });

    return NextResponse.json(product);
  } catch (caught) {
    if (caught instanceof ZodError) {
      return validationError(caught);
    }

    return NextResponse.json({ error: "Failed to update product" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const id = await getProductId(context);

    if (id === undefined) {
      return NextResponse.json({ error: "Invalid product id" }, { status: 400 });
    }

    const existing = await prisma.product.findUnique({ where: { id } });

    if (!existing) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const body = await request.json();
    const data = deleteSchema.parse(body);
    const auth = await verifySellerSignature(
      {
        sellerAddress: data.sellerAddress,
        signature: data.signature as `0x${string}`,
        signedMessage: data.signedMessage
      },
      `ChainUs:DeleteProduct:${id}:`
    );

    if (!auth.ok) {
      return NextResponse.json({ error: "Signature verification failed", reason: auth.reason }, { status: 401 });
    }

    if (existing.sellerAddress !== data.sellerAddress) {
      return NextResponse.json({ error: "Only product seller can delete this product" }, { status: 403 });
    }

    const product = await prisma.product.update({
      where: { id },
      data: { status: "inactive" }
    });

    return NextResponse.json(product);
  } catch (caught) {
    if (caught instanceof ZodError) {
      return validationError(caught);
    }

    return NextResponse.json({ error: "Failed to delete product" }, { status: 500 });
  }
}

async function getProductId(context: RouteContext) {
  const params = await context.params;
  const id = Number(params.id);

  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function validationError(error: ZodError) {
  return NextResponse.json({ error: "Validation failed", details: error.flatten() }, { status: 400 });
}
