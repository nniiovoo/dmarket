import { redirect } from "next/navigation";

import OrderDetailClient from "./OrderDetailClient";

// Server wrapper. Existed in Phase B/C as a `?marketplace=v3.2` query-string
// dispatch on a client component. Phase F moves that decision here so the
// v3.2 redirect happens as a 308 (Next's redirect()) before any client
// JS runs — and so /api/orders/v3_2/... shareable links still resolve
// even if the user pastes the legacy URL.
//
// v3 / v3.1 orders keep the original URL pattern indefinitely.

type RouteContext = {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function OrderDetailPage({ params, searchParams }: RouteContext) {
  const [{ orderId }, sp] = await Promise.all([params, searchParams]);
  const marketplaceParam = sp.marketplace;
  const marketplaceHint = Array.isArray(marketplaceParam) ? marketplaceParam[0] : marketplaceParam;

  if (marketplaceHint === "v3.2") {
    const marketplaceAddress =
      process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS ??
      process.env.V3_2_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS;
    const chainIdParam = sp.chainId;
    const chainId = Array.isArray(chainIdParam) ? chainIdParam[0] : chainIdParam ?? "421614";

    if (marketplaceAddress && /^[0-9]+$/.test(orderId)) {
      redirect(`/orders/v3_2/${chainId}/${marketplaceAddress}/${orderId}`);
    }
    // If the v3.2 marketplace env isn't configured we fall through to the
    // v3 client renderer; it will show "order not found" rather than 500.
  }

  return <OrderDetailClient />;
}
