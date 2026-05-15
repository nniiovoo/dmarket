import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { verifyWalletSignature } from "@/lib/auth";
import { computeTrackingUrl, type CarrierCode } from "@/lib/carriers";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/email/send";
import { getOrder } from "@/lib/orders";
import { orderDetailParamsSchema, shippingUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ chainId: string; onChainOrderId: string }>;
};

export const PATCH = withErrorBoundary(async (request: NextRequest, context: RouteContext) => {
  try {
    const parsedParams = orderDetailParamsSchema.safeParse(await context.params);

    if (!parsedParams.success) {
      return validationError(parsedParams.error);
    }

    const params = parsedParams.data;
    const data = shippingUpdateSchema.parse(await request.json());

    if (!data.trackingNumber) {
      return NextResponse.json({ error: "Tracking number is required when saving shipping details" }, { status: 400 });
    }

    if (data.carrier === "other" && !data.manualUrl) {
      return NextResponse.json({ error: "Manual tracking URL is required for carrier 'other'" }, { status: 400 });
    }

    const order = await prisma.onChainOrder.findUnique({
      where: {
        chainId_onChainOrderId: {
          chainId: params.chainId,
          onChainOrderId: params.onChainOrderId
        }
      }
    });

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (order.seller !== data.sellerAddress) {
      return NextResponse.json({ error: "Only the order seller can update shipping" }, { status: 403 });
    }

    if (!["Shipped", "Completed", "Disputed", "Refunded"].includes(order.status)) {
      return NextResponse.json({ error: "Order must be shipped before shipping details can be saved" }, { status: 409 });
    }

    const auth = await verifyWalletSignature(
      {
        walletAddress: data.sellerAddress,
        signature: data.signature as `0x${string}`,
        signedMessage: data.signedMessage
      },
      `ChainUs:UpdateShipping:${params.chainId}:${params.onChainOrderId}:${data.carrier}:${data.trackingNumber}:`
    );

    if (!auth.ok) {
      return NextResponse.json({ error: "Signature verification failed", reason: auth.reason }, { status: 401 });
    }

    const trackingUrl = computeTrackingUrl(data.carrier as CarrierCode, data.trackingNumber, data.manualUrl ?? undefined);

    await prisma.onChainOrder.update({
      where: {
        chainId_onChainOrderId: {
          chainId: params.chainId,
          onChainOrderId: params.onChainOrderId
        }
      },
      data: {
        carrier: data.carrier,
        trackingNumber: data.trackingNumber,
        trackingUrl,
        shippingNote: data.shippingNote || null,
        shippingUpdatedAt: new Date()
      }
    });

    const updated = await getOrder(params.chainId, params.onChainOrderId);

    if (updated) {
      void sendNotification(updated.buyer, "OrderShipped", {
        chainId: updated.chainId,
        onChainOrderId: updated.onChainOrderId
      });
    }

    return NextResponse.json(updated);
  } catch (caught) {
    if (caught instanceof ZodError) {
      return validationError(caught);
    }

    return NextResponse.json({ error: "Failed to update shipping" }, { status: 500 });
  }
});

function validationError(error: ZodError) {
  return NextResponse.json({ error: "Validation failed", details: error.flatten() }, { status: 400 });
}
