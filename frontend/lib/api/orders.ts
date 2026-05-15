import type { ApiOrder, OrderStatusName } from "@/lib/orders";

export type OrderListResponse = {
  orders: ApiOrder[];
  total: number;
};

export async function fetchOrders(params: {
  buyer?: string;
  seller?: string;
  chainId?: number;
  status?: OrderStatusName;
  limit?: number;
  offset?: number;
}) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }

  const response = await fetch(`/api/orders?${search.toString()}`);
  return parseJson<OrderListResponse>(response);
}

export async function fetchOrder(chainId: number, onChainOrderId: string) {
  const response = await fetch(`/api/orders/${chainId}/${onChainOrderId}`);
  return parseJson<ApiOrder>(response);
}

export async function fetchOrderV3_2(
  chainId: number,
  marketplaceAddress: string,
  onChainOrderId: string
) {
  const response = await fetch(
    `/api/orders/v3_2/${chainId}/${marketplaceAddress}/${onChainOrderId}`
  );
  return parseJson<ApiOrder>(response);
}

async function parseJson<T extends object>(response: Response) {
  const data = (await response.json()) as T | { error?: string; details?: unknown };

  if (!response.ok) {
    const message = "error" in data && data.error ? data.error : "Request failed";
    throw new Error(message);
  }

  return data as T;
}
