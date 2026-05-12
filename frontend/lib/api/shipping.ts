import type { ApiOrder } from "@/lib/orders";

export type ShippingUpdateInput = {
  carrier: string;
  trackingNumber: string;
  shippingNote?: string;
  manualUrl?: string | null;
  sellerAddress: string;
  signature: string;
  signedMessage: string;
};

export async function updateShipping(chainId: number, onChainOrderId: string, input: ShippingUpdateInput) {
  const response = await fetch(`/api/orders/${chainId}/${onChainOrderId}/shipping`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

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
