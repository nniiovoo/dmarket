export type Product = {
  id: number;
  sellerAddress: string;
  name: string;
  description: string;
  priceWei: string;
  chainId: number;
  imageUrl: string;
  status: "active" | "inactive" | "sold_out";
  createdAt: string;
  updatedAt: string;
};

export type ProductListResponse = {
  products: Product[];
  total: number;
};

export type ProductCreateInput = {
  name: string;
  description: string;
  priceWei: string;
  chainId: number;
  imageUrl: string;
  sellerAddress: string;
  signature: string;
  signedMessage: string;
};

export type ProductUpdateInput = Partial<Pick<Product, "name" | "description" | "priceWei" | "imageUrl" | "status">> &
  Pick<ProductCreateInput, "sellerAddress" | "signature" | "signedMessage">;

export async function fetchProducts(params: { chainId?: number; seller?: string; status?: string; limit?: number; offset?: number }) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }

  const response = await fetch(`/api/products?${search.toString()}`);
  return parseJson<ProductListResponse>(response);
}

export async function fetchProduct(id: number) {
  const response = await fetch(`/api/products/${id}`);
  return parseJson<Product>(response);
}

export async function createProduct(input: ProductCreateInput) {
  const response = await fetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseJson<Product>(response);
}

export async function updateProduct(id: number, input: ProductUpdateInput) {
  const response = await fetch(`/api/products/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseJson<Product>(response);
}

export async function deleteProduct(id: number, input: Pick<ProductCreateInput, "sellerAddress" | "signature" | "signedMessage">) {
  const response = await fetch(`/api/products/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseJson<Product>(response);
}

async function parseJson<T extends object>(response: Response) {
  const data = (await response.json()) as T | { error?: string; details?: unknown };

  if (!response.ok) {
    const message = "error" in data && data.error ? data.error : "Request failed";
    throw new Error(message);
  }

  return data as T;
}
