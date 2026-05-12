import { PrismaClient } from "@prisma/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
const prisma = new PrismaClient();

type Product = {
  id: number;
  sellerAddress: string;
  name: string;
  priceWei: string;
  chainId: number;
  status: string;
};

async function main() {
  const seller = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());
  const sellerAddress = seller.address.toLowerCase();
  const productName = `Manual Smoke Product ${Date.now()}`;

  const createMessage = `ChainUs:CreateProduct:${Date.now()}:${sellerAddress}`;
  const created = await request<Product>("/api/products", {
    method: "POST",
    body: {
      name: productName,
      description: "Created by scripts/manualTestApi.ts",
      priceWei: "1000000000000000",
      chainId: 11155111,
      imageUrl: "",
      sellerAddress,
      signature: await seller.signMessage({ message: createMessage }),
      signedMessage: createMessage
    },
    expectedStatus: 201
  });

  assert(created.id > 0, "created product id should be positive");
  assert(created.sellerAddress === sellerAddress, "created seller address should match");

  const listed = await request<{ products: Product[]; total: number }>(
    `/api/products?chainId=11155111&seller=${sellerAddress}&status=active`,
    { expectedStatus: 200 }
  );
  assert(listed.products.some((product) => product.id === created.id), "created product should be listed");

  const myProducts = await request<{ products: Product[]; total: number }>(
    `/api/products?seller=${sellerAddress}&chainId=11155111&status=active`,
    { expectedStatus: 200 }
  );
  assert(myProducts.products.some((product) => product.id === created.id), "seller product filter should return created product");

  await request("/api/orders", { expectedStatus: 400 });
  const emptyOrders = await request<{ orders: unknown[]; total: number }>(`/api/orders?seller=${sellerAddress}&chainId=11155111`, {
    expectedStatus: 200
  });
  assert(Array.isArray(emptyOrders.orders), "orders response should include an orders array");
  assert(typeof emptyOrders.total === "number", "orders response should include total");

  const pendingOrders = await request<{ orders: unknown[]; total: number }>(
    `/api/orders?seller=${sellerAddress}&chainId=11155111&status=Paid`,
    { expectedStatus: 200 }
  );
  assert(Array.isArray(pendingOrders.orders), "pending seller orders response should include an orders array");

  await requestUploadImage();
  await requestEmailEndpoints(seller, attacker, sellerAddress);
  await requestShippingEndpoints(seller, attacker, sellerAddress, attacker.address.toLowerCase(), created.id);

  const attackerAddress = attacker.address.toLowerCase();
  const badUpdateMessage = `ChainUs:UpdateProduct:${created.id}:${Date.now()}:${attackerAddress}`;
  await request(`/api/products/${created.id}`, {
    method: "PATCH",
    body: {
      name: "Should fail",
      sellerAddress: attackerAddress,
      signature: await attacker.signMessage({ message: badUpdateMessage }),
      signedMessage: badUpdateMessage
    },
    expectedStatus: 403
  });

  const updateMessage = `ChainUs:UpdateProduct:${created.id}:${Date.now()}:${sellerAddress}`;
  const updated = await request<Product>(`/api/products/${created.id}`, {
    method: "PATCH",
    body: {
      name: `${productName} Updated`,
      sellerAddress,
      signature: await seller.signMessage({ message: updateMessage }),
      signedMessage: updateMessage
    },
    expectedStatus: 200
  });
  assert(updated.name.endsWith("Updated"), "seller should be able to update product");

  const deleteMessage = `ChainUs:DeleteProduct:${created.id}:${Date.now()}:${sellerAddress}`;
  const deleted = await request<Product>(`/api/products/${created.id}`, {
    method: "DELETE",
    body: {
      sellerAddress,
      signature: await seller.signMessage({ message: deleteMessage }),
      signedMessage: deleteMessage
    },
    expectedStatus: 200
  });
  assert(deleted.status === "inactive", "delete should soft-disable product");

  console.log("Product API smoke test completed successfully");
}

async function request<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    expectedStatus: number;
  }
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = (await response.json()) as T;

  if (response.status !== options.expectedStatus) {
    throw new Error(`Expected ${options.expectedStatus} for ${path}, got ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function requestUploadImage() {
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21,
    196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 167, 56, 231, 179, 0, 0,
    0, 0, 73, 69, 78, 68, 174, 66, 96, 130
  ]);
  const form = new FormData();
  form.set("file", new File([png], "smoke.png", { type: "image/png" }));
  const response = await fetch(`${baseUrl}/api/upload-image`, {
    method: "POST",
    body: form
  });
  const data = (await response.json()) as { url?: string; code?: string; error?: string };

  if (response.status === 503 && data.code === "UPLOAD_NOT_CONFIGURED") {
    return;
  }

  if (response.status !== 200 || !data.url) {
    throw new Error(`Upload smoke failed: ${response.status}: ${JSON.stringify(data)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestEmailEndpoints(
  seller: ReturnType<typeof privateKeyToAccount>,
  attacker: ReturnType<typeof privateKeyToAccount>,
  sellerAddress: string
) {
  const email = `seller-${Date.now()}@example.com`;
  const bindMessage = `ChainUs:BindEmail:${email}:${Date.now()}:${sellerAddress}`;
  const bound = await request<{ walletAddress: string; email: string }>("/api/user/email", {
    method: "POST",
    body: {
      walletAddress: sellerAddress,
      email,
      signature: await seller.signMessage({ message: bindMessage }),
      signedMessage: bindMessage
    },
    expectedStatus: 200
  });
  assert(bound.walletAddress === sellerAddress, "email bind should return wallet address");

  const badBindMessage = `ChainUs:BindEmail:bad-${email}:${Date.now()}:${sellerAddress}`;
  await request("/api/user/email", {
    method: "POST",
    body: {
      walletAddress: sellerAddress,
      email: `bad-${email}`,
      signature: await attacker.signMessage({ message: badBindMessage }),
      signedMessage: badBindMessage
    },
    expectedStatus: 401
  });

  const status = await request<{ isBound: boolean; maskedEmail: string | null }>(`/api/user/email?address=${sellerAddress}`, {
    expectedStatus: 200
  });
  assert(status.isBound, "email status should be bound");
  assert(status.maskedEmail !== email, "email status should mask the email");
}

async function requestShippingEndpoints(
  seller: ReturnType<typeof privateKeyToAccount>,
  attacker: ReturnType<typeof privateKeyToAccount>,
  sellerAddress: string,
  buyerAddress: string,
  productId: number
) {
  const onChainOrderId = String(Date.now());
  await prisma.onChainOrder.upsert({
    where: {
      chainId_onChainOrderId: {
        chainId: 11155111,
        onChainOrderId
      }
    },
    create: {
      chainId: 11155111,
      onChainOrderId,
      buyer: buyerAddress,
      seller: sellerAddress,
      productId: String(productId),
      amountWei: "1000000000000000",
      status: "Shipped",
      createdAt: new Date(),
      paidAt: new Date(),
      shippedAt: new Date(),
      lastBlock: 1n,
      lastLogIndex: 0,
      lastTxHash: "0xsmoke"
    },
    update: {
      buyer: buyerAddress,
      seller: sellerAddress,
      productId: String(productId),
      status: "Shipped"
    }
  });

  const trackingNumber = `SMOKE${Date.now()}`;
  const shippingMessage = `ChainUs:UpdateShipping:11155111:${onChainOrderId}:usps:${trackingNumber}:${Date.now()}:${sellerAddress}`;
  const shipped = await request<{ trackingNumber: string; trackingUrl: string }> (
    `/api/orders/11155111/${onChainOrderId}/shipping`,
    {
      method: "PATCH",
      body: {
        carrier: "usps",
        trackingNumber,
        shippingNote: "Smoke test shipment",
        manualUrl: null,
        sellerAddress,
        signature: await seller.signMessage({ message: shippingMessage }),
        signedMessage: shippingMessage
      },
      expectedStatus: 200
    }
  );
  assert(shipped.trackingNumber === trackingNumber, "shipping update should persist tracking number");
  assert(shipped.trackingUrl.includes(encodeURIComponent(trackingNumber)), "shipping update should compute tracking URL");

  const attackerAddress = attacker.address.toLowerCase();
  const badShippingMessage = `ChainUs:UpdateShipping:11155111:${onChainOrderId}:usps:${trackingNumber}:${Date.now()}:${attackerAddress}`;
  await request(`/api/orders/11155111/${onChainOrderId}/shipping`, {
    method: "PATCH",
    body: {
      carrier: "usps",
      trackingNumber,
      sellerAddress: attackerAddress,
      signature: await attacker.signMessage({ message: badShippingMessage }),
      signedMessage: badShippingMessage
    },
    expectedStatus: 403
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
