import { fetchOrders } from "@/lib/api/orders";
import { fetchProducts, type ProductListResponse } from "@/lib/api/products";
import type { OrderListResponse } from "@/lib/api/orders";
import type { OrderStatusName } from "@/lib/orders";

export async function fetchSellerProducts(params: { seller: string; chainId: number; status?: string; limit?: number; offset?: number }) {
  return fetchProducts({
    seller: params.seller,
    chainId: params.chainId,
    status: params.status,
    limit: params.limit ?? 100,
    offset: params.offset ?? 0
  }) as Promise<ProductListResponse>;
}

export async function fetchSellerOrders(params: { seller: string; chainId: number; status?: OrderStatusName; limit?: number; offset?: number }) {
  return fetchOrders({
    seller: params.seller,
    chainId: params.chainId,
    status: params.status,
    limit: params.limit ?? 100,
    offset: params.offset ?? 0
  }) as Promise<OrderListResponse>;
}

export async function uploadSellerImage(file: File) {
  const body = new FormData();
  body.set("file", file);

  const response = await fetch("/api/upload-image", {
    method: "POST",
    body
  });
  const data = (await response.json()) as { url?: string; deleteUrl?: string; error?: string; code?: string };

  if (!response.ok || !data.url) {
    const error = new Error(data.error ?? "Image upload failed");
    error.name = data.code ?? "UPLOAD_FAILED";
    throw error;
  }

  return { url: data.url, deleteUrl: data.deleteUrl };
}
