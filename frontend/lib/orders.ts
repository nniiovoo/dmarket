import { prisma } from "@/lib/db";

export type OrderStatusName = "Created" | "Paid" | "Shipped" | "Completed" | "Cancelled" | "Disputed" | "Refunded";

export type ProductSummary = {
  id: number;
  name: string;
  imageUrl: string;
  status: string;
};

export type ApiOrder = {
  chainId: number;
  onChainOrderId: string;
  buyer: string;
  seller: string;
  productId: string;
  amountWei: string;
  status: OrderStatusName;
  createdAt: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  refundedAt: string | null;
  disputedAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippingNote: string | null;
  shippingUpdatedAt: string | null;
  product: ProductSummary | null;
};

export async function listOrders(params: {
  buyer?: string;
  seller?: string;
  chainId?: number;
  status?: OrderStatusName;
  limit: number;
  offset: number;
}) {
  const where = {
    ...(params.buyer !== undefined ? { buyer: params.buyer } : {}),
    ...(params.seller !== undefined ? { seller: params.seller } : {}),
    ...(params.chainId !== undefined ? { chainId: params.chainId } : {}),
    ...(params.status !== undefined ? { status: params.status } : {})
  };

  const [orders, total] = await Promise.all([
    prisma.onChainOrder.findMany({
      where,
      orderBy: [{ lastBlock: "desc" }, { lastLogIndex: "desc" }],
      take: params.limit,
      skip: params.offset
    }),
    prisma.onChainOrder.count({ where })
  ]);

  const products = await findProductsForOrders(orders);

  return {
    orders: orders.map((order) => serializeOrder(order, products.get(order.productId) ?? null)),
    total
  };
}

export async function getOrder(chainId: number, onChainOrderId: string) {
  const order = await prisma.onChainOrder.findUnique({
    where: {
      chainId_onChainOrderId: {
        chainId,
        onChainOrderId
      }
    }
  });

  if (!order) {
    return null;
  }

  const products = await findProductsForOrders([order]);
  return serializeOrder(order, products.get(order.productId) ?? null);
}

export function needsSellerAction(order: Pick<ApiOrder, "status">) {
  return order.status === "Paid";
}

async function findProductsForOrders(orders: Array<{ productId: string }>) {
  const productIds = [...new Set(orders.map((order) => toSafeProductId(order.productId)).filter((id): id is number => id !== undefined))];

  if (productIds.length === 0) {
    return new Map<string, ProductSummary>();
  }

  const products = await prisma.product.findMany({
    where: {
      id: { in: productIds }
    },
    select: {
      id: true,
      name: true,
      imageUrl: true,
      status: true
    }
  });

  return new Map(products.map((product) => [String(product.id), product]));
}

function serializeOrder(
  order: {
    chainId: number;
    onChainOrderId: string;
    buyer: string;
    seller: string;
    productId: string;
    amountWei: string;
    status: string;
    createdAt: Date | null;
    paidAt: Date | null;
    shippedAt: Date | null;
    completedAt: Date | null;
    refundedAt: Date | null;
    disputedAt: Date | null;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippingNote: string | null;
    shippingUpdatedAt: Date | null;
  },
  product: ProductSummary | null
): ApiOrder {
  return {
    chainId: order.chainId,
    onChainOrderId: order.onChainOrderId,
    buyer: order.buyer,
    seller: order.seller,
    productId: order.productId,
    amountWei: order.amountWei,
    status: order.status as OrderStatusName,
    createdAt: toIsoString(order.createdAt),
    paidAt: toIsoString(order.paidAt),
    shippedAt: toIsoString(order.shippedAt),
    completedAt: toIsoString(order.completedAt),
    refundedAt: toIsoString(order.refundedAt),
    disputedAt: toIsoString(order.disputedAt),
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
    shippingNote: order.shippingNote,
    shippingUpdatedAt: toIsoString(order.shippingUpdatedAt),
    product
  };
}

function toSafeProductId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function toIsoString(value: Date | null) {
  return value ? value.toISOString() : null;
}
