import "dotenv/config";

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ethers } from "ethers";

type PaymentAuthInput = {
  buyer: string;
  seller: string;
  productId: string | number | bigint;
  amount: string | number | bigint;
  nonce: string | number | bigint;
  deadline: string | number | bigint;
};

type SubmitBody = {
  auth?: PaymentAuthInput;
  signature?: string;
  chainId?: number;
};

type NormalizedPaymentAuth = {
  buyer: string;
  seller: string;
  productId: bigint;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

const PORT = 4001;
const MAX_AUTH_AMOUNT_WEI = 50_000_000_000_000_000n; // 0.05 ETH
const NETWORKS: Record<string, { chainId: number; rpcEnv: string; envName: string }> = {
  arbitrumSepolia: {
    chainId: 421614,
    rpcEnv: "ARBITRUM_SEPOLIA_RPC_URL",
    envName: "ARBITRUMSEPOLIA"
  }
};

const paymentAuthTypes = {
  PaymentAuth: [
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "productId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function toBigIntValue(value: string | number | bigint, field: string) {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid ${field}`);
  }
}

function normalizeAuth(auth: PaymentAuthInput | undefined) {
  if (!auth) throw new Error("Missing auth");
  if (!ethers.isAddress(auth.buyer)) throw new Error("Invalid auth.buyer");
  if (!ethers.isAddress(auth.seller)) throw new Error("Invalid auth.seller");

  return {
    buyer: ethers.getAddress(auth.buyer),
    seller: ethers.getAddress(auth.seller),
    productId: toBigIntValue(auth.productId, "auth.productId"),
    amount: toBigIntValue(auth.amount, "auth.amount"),
    nonce: toBigIntValue(auth.nonce, "auth.nonce"),
    deadline: toBigIntValue(auth.deadline, "auth.deadline")
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<SubmitBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as SubmitBody;
}

function elapsed(startedAt: bigint) {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

function log(startedAt: bigint, message: string) {
  console.log(`[T+${elapsed(startedAt)}ms] ${message}`);
}

// --- Transient-error retry helpers --------------------------------------
//
// Alchemy free tier returns 429 / "compute units exceeded" / "Too Many
// Requests" under load. The default ethers behaviour is to surface those
// straight up to the caller, which means a transient blip kills the
// whole relayer submission and the frontend gives up on the user. Wrap
// any RPC-touching call with `withRpcRetry` so transient failures get
// up to 3 backoff retries before we surrender.

const RETRY_DELAYS_MS = [2000, 4000, 8000] as const;

const TRANSIENT_PATTERNS = [
  /429/i,
  /too many requests/i,
  /compute units/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /bad response/i,
  /nonce too low/i,
  /rate.?limit/i,
  /server.?error/i,
  /service unavailable/i,
  /503/
];

function flattenErrorMessages(error: unknown): string {
  // ethers v6 wraps RPC failures in a few layers (error.error, error.info,
  // error.cause). Walk them and collect every text fragment so we can
  // pattern-match against the inner provider error.
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
    } else if (typeof current === "string") {
      parts.push(current);
    } else if (typeof current === "object") {
      try {
        parts.push(JSON.stringify(current));
      } catch {
        /* circular — already captured the rest */
      }
    }

    const next = current as { cause?: unknown; error?: unknown; info?: unknown };
    current = next.cause ?? next.error ?? next.info ?? null;
  }

  return parts.join(" | ");
}

function isTransientRpcError(error: unknown): boolean {
  const message = flattenErrorMessages(error);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

function shortReason(error: unknown): string {
  const message = flattenErrorMessages(error);
  // First 120 chars is usually enough to identify which transient case it
  // was without spamming the relayer log with a stack trace.
  return message.slice(0, 120);
}

async function withRpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientRpcError(error)) {
        throw error;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(
        `[retry attempt=${attempt + 1} delay=${delay / 1000}s label=${label} reason="${shortReason(error)}"]`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function findOrderCreatedId(receipt: { logs: Array<{ topics: readonly string[]; data: string }> }, iface: import("ethers").Interface) {
  for (const entry of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: [...entry.topics], data: entry.data });
      if (parsed?.name === "OrderCreated") {
        return parsed.args.orderId as bigint;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function getCliNetworkName() {
  const networkFlagIndex = process.argv.indexOf("--network");
  if (networkFlagIndex >= 0) return process.argv[networkFlagIndex + 1];

  const networkFlag = process.argv.find((arg) => arg.startsWith("--network="));
  return networkFlag?.split("=")[1] ?? "arbitrumSepolia";
}

function loadMarketplaceArtifact() {
  const artifactPath = join(
    process.cwd(),
    "artifacts/contracts/v3_1/EscrowMarketplaceV3_1.sol/EscrowMarketplaceV3_1.json"
  );
  return JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: ethers.InterfaceAbi };
}

async function main() {
  const networkName = getCliNetworkName();
  const selectedNetwork = NETWORKS[networkName];
  if (!selectedNetwork) {
    throw new Error(`Unsupported relayer network: ${networkName}`);
  }

  const provider = new ethers.JsonRpcProvider(requireEnv(selectedNetwork.rpcEnv));
  const detectedNetwork = await provider.getNetwork();
  const expectedChainId = selectedNetwork.chainId;
  if (Number(detectedNetwork.chainId) !== expectedChainId) {
    throw new Error(`RPC chainId mismatch: expected ${expectedChainId}, got ${detectedNetwork.chainId}`);
  }

  const envNetworkName = selectedNetwork.envName;
  const marketplaceAddress = requireEnv(`V3_1_${envNetworkName}_MARKETPLACE_ADDRESS`);
  const relayerKey = process.env.RELAYER_PRIVATE_KEY || requireEnv("PRIVATE_KEY");
  const relayer = new ethers.Wallet(relayerKey, provider);
  const marketplace = new ethers.Contract(marketplaceAddress, loadMarketplaceArtifact().abi, relayer);

  console.log("ChainUs V3.1 relayer listening on http://localhost:4001");
  console.log("Network:", networkName, `(${expectedChainId})`);
  console.log("Marketplace:", marketplaceAddress);
  console.log("Relayer:", relayer.address);

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return;
    }

    if (req.method !== "POST" || req.url !== "/submit") {
      json(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const startedAt = process.hrtime.bigint();
    try {
      log(startedAt, "received");
      const body = await readJson(req);

      if (body.chainId !== expectedChainId) {
        json(res, 400, { ok: false, error: `Wrong chainId: expected ${expectedChainId}` });
        return;
      }
      if (!body.signature || typeof body.signature !== "string") {
        json(res, 400, { ok: false, error: "Missing signature" });
        return;
      }

      const auth = normalizeAuth(body.auth);
      if (auth.amount > MAX_AUTH_AMOUNT_WEI) {
        json(res, 400, { ok: false, error: "Auth amount exceeds 0.05 ETH relayer safety limit" });
        return;
      }
      // Wrap the balance read too — Alchemy will happily 429 you on a
      // plain eth_getBalance during a burst.
      const relayerBalance = await withRpcRetry("getBalance", () =>
        provider.getBalance(relayer.address)
      );
      console.log(`[smoke] auth.buyer    = ${auth.buyer}`);
      console.log(`[smoke] auth.amount   = ${ethers.formatEther(auth.amount)} ETH`);
      console.log(
        `[smoke] relayer wallet balance: ${ethers.formatEther(relayerBalance)} ETH on Arbitrum Sepolia`
      );

      const domain = {
        name: "ChainUsEscrow",
        version: "3.1",
        chainId: expectedChainId,
        verifyingContract: marketplaceAddress
      };
      const recovered = ethers.verifyTypedData(domain, paymentAuthTypes, auth, body.signature);
      if (ethers.getAddress(recovered) !== auth.buyer) {
        json(res, 401, { ok: false, error: "Signature does not recover to auth.buyer" });
        return;
      }
      log(startedAt, "sig verified");

      console.log("[smoke] sending tx...");
      // Retry the send itself. Notable case: `nonce too low` (transient
      // for us because ethers caches the nonce; re-reading + resigning
      // succeeds on the second try once the provider catches up).
      const tx = await withRpcRetry("createAndPayWithAuth", () =>
        marketplace.createAndPayWithAuth(auth, body.signature, { value: auth.amount })
      );
      console.log(`[smoke] tx hash = ${tx.hash}`);
      log(startedAt, `tx submitted ${tx.hash}`);

      // Receipt polling can also hit 429 on slow networks. Wrap.
      const receipt = await withRpcRetry("tx.wait", () => tx.wait());
      if (!receipt) {
        throw new Error("No transaction receipt returned");
      }
      const orderId = findOrderCreatedId(receipt, marketplace.interface);
      if (orderId === undefined) {
        throw new Error("OrderCreated event not found");
      }

      console.log(`[smoke] confirmed -> orderId = ${orderId.toString()}`);
      log(startedAt, "tx confirmed");
      json(res, 200, { ok: true, txHash: tx.hash, orderId: orderId.toString() });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Relayer submission failed";
      console.error(`[T+${elapsed(startedAt)}ms] failed`, error);
      json(res, 500, { ok: false, error: message });
    }
  });

  server.listen(PORT);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
