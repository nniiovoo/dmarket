import { prisma } from "@/lib/db";

export type OrderStatusName = "Created" | "Paid" | "Shipped" | "Completed" | "Cancelled" | "Disputed" | "Refunded";

// Which marketplace contract this order lives in. Email templates and the
// order detail link use this to pick the right URL ("/orders/..." for V3,
// "/v3_1/orders/..." for V3.1).
export type MarketplaceVersion = "v3" | "v3.1" | "v3.2";

// Status int → human label. Mirrors the on-chain OrderStatus enum and the
// v3.2 schema's `status` Int column.
const STATUS_NAMES: OrderStatusName[] = [
  "Created",
  "Paid",
  "Shipped",
  "Completed",
  "Cancelled",
  "Disputed",
  "Refunded"
];

export function orderStatusName(value: number): OrderStatusName {
  return STATUS_NAMES[value] ?? "Created";
}

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
  lastTxHash: string | null;
  product: ProductSummary | null;
  marketplaceVersion: MarketplaceVersion;
  // Present only for v3.2 orders. For v3/v3.1 these stay undefined and the
  // payment is implicitly native.
  paymentToken?: string;
  marketplaceAddress?: string;
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
    orders: orders.map((order) => serializeOrder(order, products.get(order.productId) ?? null, "v3")),
    total
  };
}

export async function getOrder(
  chainId: number,
  onChainOrderId: string,
  marketplaceVersion: MarketplaceVersion = "v3"
) {
  // V3.1 orders live in OnChainOrderV3_1 — they have an independent
  // orderId counter, so V3 #N and V3.1 #N are unrelated. Same column
  // layout, so serializeOrder works for both.
  const order =
    marketplaceVersion === "v3.1"
      ? await prisma.onChainOrderV3_1.findUnique({
          where: { chainId_onChainOrderId: { chainId, onChainOrderId } }
        })
      : await prisma.onChainOrder.findUnique({
          where: { chainId_onChainOrderId: { chainId, onChainOrderId } }
        });

  if (!order) {
    return null;
  }

  const products = await findProductsForOrders([order]);
  return serializeOrder(order, products.get(order.productId) ?? null, marketplaceVersion);
}

export function needsSellerAction(order: Pick<ApiOrder, "status">) {
  return order.status === "Paid";
}

// v3.2 lookup. Keyed on (chainId, marketplaceAddress, onChainOrderId) so
// orders from a redeploy or a parallel v3.2 marketplace don't collide. The
// caller is expected to pass the lowercased marketplace address; we lowercase
// again here defensively.
export async function getOrderV3_2(
  chainId: number,
  marketplaceAddress: string,
  onChainOrderId: string
): Promise<ApiOrder | null> {
  const lowerAddress = marketplaceAddress.toLowerCase();
  const order = await prisma.onChainOrderV3_2.findUnique({
    where: {
      chainId_marketplaceAddress_onChainOrderId: {
        chainId,
        marketplaceAddress: lowerAddress,
        onChainOrderId
      }
    }
  });

  if (!order) return null;

  const products = await findProductsForOrders([{ productId: order.productId }]);
  const product = products.get(order.productId) ?? null;

  return {
    chainId: order.chainId,
    onChainOrderId: order.onChainOrderId,
    buyer: order.buyer,
    seller: order.seller,
    productId: order.productId,
    amountWei: order.amount,
    status: orderStatusName(order.status),
    createdAt: toIsoString(order.createdAt),
    paidAt: toIsoString(order.paidAt),
    shippedAt: toIsoString(order.shippedAt),
    completedAt: toIsoString(order.completedAt),
    // v3.2 doesn't have a separate refundedAt column — it only flips status
    // to Refunded when resolveDispute(refundBuyer=true) fires. Use the
    // resolution time stored in disputedAt's slot? No — disputedAt is the
    // *open* timestamp. Leave refundedAt null; if Phase D needs it we add
    // a column then rather than synthesise it here.
    refundedAt: null,
    disputedAt: toIsoString(order.disputedAt),
    carrier: null,
    trackingNumber: null,
    trackingUrl: null,
    shippingNote: null,
    shippingUpdatedAt: null,
    lastTxHash: order.lastEventTxHash,
    product,
    marketplaceVersion: "v3.2",
    paymentToken: order.paymentToken,
    marketplaceAddress: order.marketplaceAddress
  };
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
    lastTxHash: string | null;
  },
  product: ProductSummary | null,
  marketplaceVersion: MarketplaceVersion
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
    lastTxHash: order.lastTxHash,
    product,
    marketplaceVersion
  };
}

// Postgres Product.id is INT4; anything bigger than 2^31-1 cannot be passed
// to prisma.product.findMany without a binding error. v3.2 smoke / demo
// scripts have legitimately used productIds derived from Date.now() (~1.7e12),
// which fit Number.isSafeInteger but exceed INT4. Reject those here so the
// caller treats them as "no Product join available" and the order API still
// returns the chain-side fields.
const POSTGRES_INT4_MAX = 2_147_483_647;
function toSafeProductId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= POSTGRES_INT4_MAX ? id : undefined;
}

function toIsoString(value: Date | null) {
  return value ? value.toISOString() : null;
}
