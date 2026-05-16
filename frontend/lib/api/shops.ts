// Frontend client for the K.5a shop-economy read APIs. All four
// endpoints are GETs against the indexer's projection — no auth, no
// writes. The shapes here mirror the API responses verbatim so a
// future contract / indexer change is caught at the boundary.

export interface ShopSummary {
  shopId: number;
  currentOwner: string;
  creator: string;
  createdAt: string; // ISO
  name: string;
  description: string;
  imageUrl: string;
  sharesInitialized: boolean;
  totalShareholders: number;
  /// "10000" once shares are initialised, else "0". Stored as a string
  /// because the underlying value is a uint256 — small enough to fit in
  /// a Number today, but the API contract is bigint-as-string.
  totalSharesIssued: string;
  lastUpdatedBlock?: string;
  lastUpdatedTxHash?: string;
}

export interface ShopHolding {
  holder: string;
  /// uint256 stringified.
  balance: string;
  /// Server-computed XX.XX percentage of the 10 000-share supply.
  pct: string;
}

export type ShopListingStatus = "Active" | "Filled" | "Cancelled";

export interface ShopListing {
  listingId: number;
  seller: string;
  shopId: number;
  amount: string;
  paymentToken: string;
  totalPrice: string;
  // M.1 partial-fill fields. Nullable so legacy K.4 rows still
  // deserialize. New listings always populate all three; UI can fall
  // back to (amount, totalPrice) when these are null.
  originalAmount: string | null;
  remainingAmount: string | null;
  pricePerToken: string | null;
  status: ShopListingStatus;
  statusCode: number;
  buyer: string | null;
  createdBlock: string;
  createdTxHash: string;
  closedBlock: string | null;
  closedTxHash: string | null;
}

export interface ListShopsResponse {
  shops: ShopSummary[];
  total: number;
}

export interface ShopHoldingsResponse {
  shopId: number;
  holdings: ShopHolding[];
  totalShareholders: number;
}

export interface ShopListingsResponse {
  listings: ShopListing[];
  total: number;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = typeof body?.error === "string" ? `: ${body.error}` : "";
    } catch {
      // ignore — fall back to the bare status
    }
    throw new ShopsApiError(`${url} returned ${res.status}${detail}`, res.status);
  }
  return (await res.json()) as T;
}

export class ShopsApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function listShops(limit = 20, offset = 0): Promise<ListShopsResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return getJson<ListShopsResponse>(`/api/shops/list?${params.toString()}`);
}

/// Returns null when the shop hasn't been indexed yet (404). Other
/// errors propagate so the UI can render an error boundary.
export async function getShop(shopId: number): Promise<ShopSummary | null> {
  try {
    return await getJson<ShopSummary>(`/api/shops/${shopId}`);
  } catch (err) {
    if (err instanceof ShopsApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getShopHoldings(shopId: number): Promise<ShopHoldingsResponse> {
  return getJson<ShopHoldingsResponse>(`/api/shops/${shopId}/holdings`);
}

export async function getShopListings(
  shopId: number,
  status: "active" | "filled" | "cancelled" | "all" = "all"
): Promise<ShopListingsResponse> {
  const params = new URLSearchParams({
    shopId: String(shopId),
    status,
    limit: "100"
  });
  return getJson<ShopListingsResponse>(`/api/listings?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// User-scoped reads (K.6b additions)
// ---------------------------------------------------------------------------

export interface UserHolding {
  shopId: number;
  balance: string;
  pct: string;
  shopName: string;
  shopCurrentOwner: string | null;
  shopImageUrl: string;
  lastUpdatedBlock: string;
}

export interface UserHoldingsResponse {
  holder: string;
  holdings: UserHolding[];
  total: number;
}

export interface UserListingsResponse {
  seller: string;
  listings: ShopListing[];
  total: number;
}

export async function getUserHoldings(address: string): Promise<UserHoldingsResponse> {
  return getJson<UserHoldingsResponse>(`/api/users/${address}/holdings`);
}

export async function getUserListings(
  address: string,
  status: "active" | "filled" | "cancelled" | "all" = "all"
): Promise<UserListingsResponse> {
  const params = new URLSearchParams({ status });
  return getJson<UserListingsResponse>(`/api/users/${address}/listings?${params.toString()}`);
}
