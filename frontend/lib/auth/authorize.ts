// Authorization for evidence file access.
//
// An address is allowed to view a given evidence file if ANY of these hold:
//   1. Address is the buyer or seller of the order the evidence belongs to.
//   2. Address is in the platform admin allowlist (EVIDENCE_ADMIN_ADDRESSES
//      env, comma-separated).
//   3. Address is a juror selected by Kleros V2 for the dispute associated
//      with the order. We query our adapter for orderToDisputeID, then ask
//      KlerosCore for the drawn jurors of the current round.
//
// Each check returns the reason that granted access; the upload endpoint
// records this so admins can audit who saw what and why.

import type { Address } from "viem";
import { createPublicClient, getAddress, http } from "viem";
import { arbitrumSepolia, polygonAmoy, sepolia } from "viem/chains";

import { klerosV2DisputeAdapterAbi } from "@/lib/contracts";
import { prisma } from "@/lib/db";

const CHAINS: Record<number, ReturnType<typeof createPublicClient>> = {};

function clientFor(chainId: number) {
  if (CHAINS[chainId]) return CHAINS[chainId];

  const rpc =
    chainId === sepolia.id
      ? (process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC_URL)
      : chainId === polygonAmoy.id
        ? (process.env.NEXT_PUBLIC_AMOY_RPC_URL ?? process.env.AMOY_RPC_URL)
        : chainId === arbitrumSepolia.id
          ? (process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL)
          : undefined;

  const chain =
    chainId === sepolia.id
      ? sepolia
      : chainId === polygonAmoy.id
        ? polygonAmoy
        : chainId === arbitrumSepolia.id
          ? arbitrumSepolia
          : undefined;

  if (!rpc || !chain) {
    throw new Error(`No RPC client for chain ${chainId}`);
  }

  const c = createPublicClient({ chain, transport: http(rpc) });
  CHAINS[chainId] = c;
  return c;
}

function adminAddresses(): Set<string> {
  const raw = process.env.EVIDENCE_ADMIN_ADDRESSES ?? "";
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      set.add(trimmed.toLowerCase());
    }
  }
  return set;
}

function klerosAdapterAddressFor(chainId: number): Address | undefined {
  if (chainId === sepolia.id) {
    return (process.env.NEXT_PUBLIC_KLEROS_ADAPTER_SEPOLIA_ADDRESS ??
      process.env.KLEROS_ADAPTER_SEPOLIA_ADDRESS) as Address | undefined;
  }
  if (chainId === polygonAmoy.id) {
    return (process.env.NEXT_PUBLIC_KLEROS_ADAPTER_AMOY_ADDRESS ??
      process.env.KLEROS_ADAPTER_AMOY_ADDRESS) as Address | undefined;
  }
  if (chainId === arbitrumSepolia.id) {
    return (process.env.NEXT_PUBLIC_KLEROS_ADAPTER_ARBITRUMSEPOLIA_ADDRESS ??
      process.env.KLEROS_ADAPTER_ARBITRUMSEPOLIA_ADDRESS) as Address | undefined;
  }
  return undefined;
}

const KLEROS_CORE_ABI = [
  // V2 KlerosCore.getRoundInfo. Returns the drawnJurors for a given round.
  // Signature confirmed against scripts/sepoliaTest/_checkKlerosDispute.ts.
  {
    type: "function",
    name: "disputes",
    stateMutability: "view",
    inputs: [{ name: "_disputeID", type: "uint256" }],
    outputs: [
      { name: "courtID", type: "uint96" },
      { name: "arbitrated", type: "address" },
      { name: "lastPeriodChange", type: "uint256" },
      { name: "nbRounds", type: "uint256" },
      { name: "currentRound", type: "uint256" },
      { name: "period", type: "uint8" },
      { name: "ruled", type: "bool" }
    ]
  },
  {
    type: "function",
    name: "getRoundInfo",
    stateMutability: "view",
    inputs: [
      { name: "_disputeID", type: "uint256" },
      { name: "_round", type: "uint256" }
    ],
    outputs: [
      { name: "jurorsAtStake", type: "uint256" },
      { name: "totalFeesForJurors", type: "uint256" },
      { name: "repartitions", type: "uint256" },
      { name: "penalties", type: "uint256" },
      { name: "drawnJurors", type: "address[]" },
      { name: "nbVotes", type: "uint256" }
    ]
  }
] as const;

export type AuthzGrant =
  | { allowed: true; reason: "buyer" | "seller" | "admin" | "kleros_juror" }
  | { allowed: false; reason: "not_party" | "no_session" | "auth_error"; detail?: string };

export type MarketplaceVersion = "v3" | "v3.1";

// Look up an order across BOTH V3 and V3.1 tables. Used when the caller
// didn't pass marketplaceVersion — typical for evidence file reads, since
// EvidenceUpload doesn't carry the version column, so we have to infer
// from which table actually holds the order. Same orderId in V3 vs V3.1
// maps to unrelated orders; we MUST check the table where the order lives.
async function findOrderEitherVersion(
  chainId: number,
  onChainOrderId: string
): Promise<{ buyer: string; seller: string; marketplaceVersion: MarketplaceVersion } | null> {
  const v3 = await prisma.onChainOrder.findUnique({
    where: { chainId_onChainOrderId: { chainId, onChainOrderId } },
    select: { buyer: true, seller: true }
  });
  if (v3) return { ...v3, marketplaceVersion: "v3" };

  const v3_1 = await prisma.onChainOrderV3_1.findUnique({
    where: { chainId_onChainOrderId: { chainId, onChainOrderId } },
    select: { buyer: true, seller: true }
  });
  if (v3_1) return { ...v3_1, marketplaceVersion: "v3.1" };

  return null;
}

async function findOrderForVersion(
  chainId: number,
  onChainOrderId: string,
  version: MarketplaceVersion
): Promise<{ buyer: string; seller: string } | null> {
  if (version === "v3.1") {
    return prisma.onChainOrderV3_1.findUnique({
      where: { chainId_onChainOrderId: { chainId, onChainOrderId } },
      select: { buyer: true, seller: true }
    });
  }
  return prisma.onChainOrder.findUnique({
    where: { chainId_onChainOrderId: { chainId, onChainOrderId } },
    select: { buyer: true, seller: true }
  });
}

export async function authorizeForOrder(
  viewer: Address | null,
  chainId: number,
  onChainOrderId: string,
  marketplaceVersion?: MarketplaceVersion
): Promise<AuthzGrant> {
  if (!viewer) return { allowed: false, reason: "no_session" };

  const lower = viewer.toLowerCase();

  // 1. Party check. If marketplaceVersion was specified, query that table
  // directly; otherwise probe both and use whichever holds the order.
  // findOrderEitherVersion tags the result with the table it came from so
  // we can route the Kleros check correctly downstream.
  let order: { buyer: string; seller: string } | null;
  let resolvedVersion: MarketplaceVersion;
  if (marketplaceVersion) {
    order = await findOrderForVersion(chainId, onChainOrderId, marketplaceVersion);
    resolvedVersion = marketplaceVersion;
  } else {
    const found = await findOrderEitherVersion(chainId, onChainOrderId);
    order = found;
    resolvedVersion = found?.marketplaceVersion ?? "v3";
  }

  if (order) {
    if (order.buyer.toLowerCase() === lower) return { allowed: true, reason: "buyer" };
    if (order.seller.toLowerCase() === lower) return { allowed: true, reason: "seller" };
  }

  // 2. Admin allowlist (env)
  if (adminAddresses().has(lower)) return { allowed: true, reason: "admin" };

  // 3. Kleros juror check. V3 marketplace is wired to the Kleros adapter;
  // V3.1 isn't (yet). For V3.1 orders we skip the Kleros lookup entirely —
  // there's no adapter to query, so pretending otherwise would just emit
  // spurious "auth_error" responses. Revisit when V3.1 gets its own adapter.
  if (resolvedVersion === "v3.1") {
    return { allowed: false, reason: "not_party" };
  }

  // Errors below downgrade to not_party rather than crashing the request —
  // auth is best-effort beyond the cheap checks above.
  try {
    const adapterAddr = klerosAdapterAddressFor(chainId);
    if (!adapterAddr) return { allowed: false, reason: "not_party" };

    const client = clientFor(chainId);

    const disputeId = (await client.readContract({
      address: adapterAddr,
      abi: klerosV2DisputeAdapterAbi,
      functionName: "orderToDisputeID",
      args: [BigInt(onChainOrderId)]
    })) as bigint;

    if (disputeId === 0n) {
      // No dispute escalated to Kleros for this order.
      return { allowed: false, reason: "not_party" };
    }

    const arbitratorAddr = (await client.readContract({
      address: adapterAddr,
      abi: klerosV2DisputeAdapterAbi,
      functionName: "arbitrator"
    })) as Address;

    const dispute = (await client.readContract({
      address: arbitratorAddr,
      abi: KLEROS_CORE_ABI,
      functionName: "disputes",
      args: [disputeId]
    })) as readonly [bigint, Address, bigint, bigint, bigint, number, boolean];
    const currentRound = dispute[4];

    const roundInfo = (await client.readContract({
      address: arbitratorAddr,
      abi: KLEROS_CORE_ABI,
      functionName: "getRoundInfo",
      args: [disputeId, currentRound]
    })) as readonly [bigint, bigint, bigint, bigint, readonly Address[], bigint];
    const drawnJurors = roundInfo[4];

    for (const j of drawnJurors) {
      if (j.toLowerCase() === lower) {
        return { allowed: true, reason: "kleros_juror" };
      }
    }
    return { allowed: false, reason: "not_party" };
  } catch (err) {
    return {
      allowed: false,
      reason: "auth_error",
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

// Convenience for upload endpoint: just the party check, no Kleros lookup.
// Pass marketplaceVersion when the caller knows it (the upload form does);
// when undefined, fall back to probing both tables.
export async function isOrderParty(
  viewer: Address,
  chainId: number,
  onChainOrderId: string,
  marketplaceVersion?: MarketplaceVersion
) {
  const lower = viewer.toLowerCase();
  const order = marketplaceVersion
    ? await findOrderForVersion(chainId, onChainOrderId, marketplaceVersion)
    : await findOrderEitherVersion(chainId, onChainOrderId);
  if (!order) return false;
  return order.buyer.toLowerCase() === lower || order.seller.toLowerCase() === lower;
}

// Normalise an env-supplied address; throws if malformed.
export function normalizeAddress(s: string): Address {
  return getAddress(s);
}
