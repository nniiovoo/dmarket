import type { Abi, Address } from "viem";
import { arbitrumSepolia, polygonAmoy, sepolia } from "wagmi/chains";

import escrowMarketplaceV2AbiJson from "@/abi/EscrowMarketplaceV2.json";
import escrowVaultAbiJson from "@/abi/EscrowVault.json";
import escrowMarketplaceV3AbiJson from "@/abi/EscrowMarketplaceV3.json";
import escrowMarketplaceV3_1AbiJson from "@/abi/EscrowMarketplaceV3_1.json";
import escrowVaultV3AbiJson from "@/abi/EscrowVaultV3.json";
import evidenceRegistryV3AbiJson from "@/abi/EvidenceRegistryV3.json";
import klerosAdapterAbiJson from "@/abi/KlerosV2DisputeAdapter.json";

export const escrowMarketplaceV2Abi = escrowMarketplaceV2AbiJson as Abi;
export const escrowVaultAbi = escrowVaultAbiJson as Abi;
export const escrowMarketplaceV3Abi = escrowMarketplaceV3AbiJson as Abi;
export const escrowMarketplaceV3_1Abi = escrowMarketplaceV3_1AbiJson as Abi;
export const escrowVaultV3Abi = escrowVaultV3AbiJson as Abi;
export const evidenceRegistryV3Abi = evidenceRegistryV3AbiJson as Abi;
export const klerosV2DisputeAdapterAbi = klerosAdapterAbiJson as Abi;

const fallbackAddresses = {
  [sepolia.id]: {
    marketplace: "0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366",
    vault: "0x4F2350154A34d8D87013Cab3E1001311186fb839"
  },
  [polygonAmoy.id]: {
    marketplace: "0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD",
    vault: "0xdCeD6FC8cF7CEF86b630f1978d0B78655d103f1E"
  }
} as const;

export type ContractAddresses = {
  marketplace: Address;
  vault: Address;
};

export type V3ContractAddresses = {
  marketplace: Address;
  vault: Address;
  evidenceRegistry?: Address;
  klerosAdapter?: Address;
};

export type V3_1ContractAddresses = {
  marketplace: Address;
  vault: Address;
  // V3.1 has its own EvidenceRegistry instance, separate from V3's. Same
  // contract source, just deployed twice — each instance is bound to a
  // different marketplace in its constructor.
  evidenceRegistry?: Address;
};

export type ActiveMarketplaceV2 = {
  version: "v2";
  abi: Abi;
  address: Address;
  vault: Address;
};

export type ActiveMarketplaceV3 = {
  version: "v3";
  abi: Abi;
  address: Address;
  vault: Address;
  evidenceRegistry?: Address;
  klerosAdapter?: Address;
};

export type ActiveMarketplace = ActiveMarketplaceV2 | ActiveMarketplaceV3;

export function getContractAddresses(chainId: number | undefined): ContractAddresses | undefined {
  if (chainId === undefined) {
    return undefined;
  }

  if (chainId === sepolia.id) {
    return {
      marketplace:
        (process.env.NEXT_PUBLIC_V2_SEPOLIA_MARKETPLACE_ADDRESS as Address | undefined) ??
        fallbackAddresses[sepolia.id].marketplace,
      vault:
        (process.env.NEXT_PUBLIC_V2_SEPOLIA_VAULT_ADDRESS as Address | undefined) ??
        fallbackAddresses[sepolia.id].vault
    };
  }

  if (chainId === polygonAmoy.id) {
    return {
      marketplace:
        (process.env.NEXT_PUBLIC_V2_AMOY_MARKETPLACE_ADDRESS as Address | undefined) ??
        fallbackAddresses[polygonAmoy.id].marketplace,
      vault:
        (process.env.NEXT_PUBLIC_V2_AMOY_VAULT_ADDRESS as Address | undefined) ?? fallbackAddresses[polygonAmoy.id].vault
    };
  }

  return undefined;
}

export function getV3ContractAddresses(chainId: number | undefined): V3ContractAddresses | undefined {
  if (chainId === undefined) return undefined;

  if (chainId === sepolia.id) {
    const marketplace = process.env.NEXT_PUBLIC_V3_SEPOLIA_MARKETPLACE_ADDRESS as Address | undefined;
    const vault = process.env.NEXT_PUBLIC_V3_SEPOLIA_VAULT_ADDRESS as Address | undefined;
    if (!marketplace || !vault) return undefined;
    return {
      marketplace,
      vault,
      evidenceRegistry: process.env.NEXT_PUBLIC_V3_SEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined,
      klerosAdapter: process.env.NEXT_PUBLIC_KLEROS_ADAPTER_SEPOLIA_ADDRESS as Address | undefined
    };
  }

  if (chainId === polygonAmoy.id) {
    const marketplace = process.env.NEXT_PUBLIC_V3_AMOY_MARKETPLACE_ADDRESS as Address | undefined;
    const vault = process.env.NEXT_PUBLIC_V3_AMOY_VAULT_ADDRESS as Address | undefined;
    if (!marketplace || !vault) return undefined;
    return {
      marketplace,
      vault,
      evidenceRegistry: process.env.NEXT_PUBLIC_V3_AMOY_EVIDENCE_REGISTRY_ADDRESS as Address | undefined
    };
  }

  if (chainId === arbitrumSepolia.id) {
    const marketplace = process.env.NEXT_PUBLIC_V3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS as Address | undefined;
    const vault = process.env.NEXT_PUBLIC_V3_ARBITRUMSEPOLIA_VAULT_ADDRESS as Address | undefined;
    if (!marketplace || !vault) return undefined;
    return {
      marketplace,
      vault,
      evidenceRegistry: process.env.NEXT_PUBLIC_V3_ARBITRUMSEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined,
      klerosAdapter: process.env.NEXT_PUBLIC_KLEROS_ADAPTER_ARBITRUMSEPOLIA_ADDRESS as Address | undefined
    };
  }

  return undefined;
}

export function getV3_1ContractAddresses(chainId: number | undefined): V3_1ContractAddresses | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;

  const marketplace = process.env.NEXT_PUBLIC_V3_1_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS as Address | undefined;
  const vault = process.env.NEXT_PUBLIC_V3_1_ARBITRUMSEPOLIA_VAULT_ADDRESS as Address | undefined;

  if (!marketplace || !vault) return undefined;
  return {
    marketplace,
    vault,
    evidenceRegistry: process.env.NEXT_PUBLIC_V3_1_ARBITRUMSEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined
  };
}

// Picks the right EvidenceRegistry instance for the order. V3 and V3.1 have
// separate registries; submitting a V3.1 order's evidence to the V3
// registry would revert (registry's marketplace() check fails).
export function getEvidenceRegistryForOrder(order: {
  chainId: number;
  marketplaceVersion: "v3" | "v3.1";
}): Address | undefined {
  if (order.marketplaceVersion === "v3.1") {
    return getV3_1ContractAddresses(order.chainId)?.evidenceRegistry;
  }
  return getV3ContractAddresses(order.chainId)?.evidenceRegistry;
}

export function hasV3_1OnChain(chainId: number | undefined): boolean {
  return getV3_1ContractAddresses(chainId) !== undefined;
}

export function isSupportedChain(chainId: number | undefined) {
  return getContractAddresses(chainId) !== undefined;
}

/// Returns the marketplace ABI + address active on the given chain,
/// auto-selecting V2 or V3. Components should call this rather than
/// hardcoding V2 lookups so they work on Arbitrum Sepolia too.
export function getActiveMarketplace(chainId: number | undefined): ActiveMarketplace | undefined {
  if (chainId === undefined) return undefined;

  if (chainId === sepolia.id || chainId === polygonAmoy.id) {
    const v2 = getContractAddresses(chainId);
    if (!v2) return undefined;
    return {
      version: "v2",
      abi: escrowMarketplaceV2Abi,
      address: v2.marketplace,
      vault: v2.vault
    };
  }

  if (chainId === arbitrumSepolia.id) {
    const v3 = getV3ContractAddresses(chainId);
    if (!v3) return undefined;
    return {
      version: "v3",
      abi: escrowMarketplaceV3Abi,
      address: v3.marketplace,
      vault: v3.vault,
      evidenceRegistry: v3.evidenceRegistry,
      klerosAdapter: v3.klerosAdapter
    };
  }

  return undefined;
}

/// Catch-all: any chain with either V2 or V3 deployed is "supported"
/// for marketplace operations.
export function hasMarketplace(chainId: number | undefined): boolean {
  return getActiveMarketplace(chainId) !== undefined;
}

export function isV3Supported(chainId: number | undefined) {
  return getV3ContractAddresses(chainId) !== undefined;
}

export function isEvidenceRegistryDeployed(chainId: number | undefined) {
  const addrs = getV3ContractAddresses(chainId);
  return addrs?.evidenceRegistry !== undefined;
}

export function isKlerosAdapterDeployed(chainId: number | undefined): boolean {
  return chainId === arbitrumSepolia.id && getV3ContractAddresses(chainId)?.klerosAdapter !== undefined;
}

/** Returns the v2-testnet.kleros.builders URL for a given Kleros disputeID
    on Arbitrum Sepolia. Returns undefined if the chain doesn't have a known
    Kleros UI. */
export function getKlerosCaseUrl(chainId: number | undefined, disputeID: bigint | string): string | undefined {
  if (chainId === arbitrumSepolia.id) {
    return `https://v2-testnet.kleros.builders/#/cases/${disputeID.toString()}`;
  }
  return undefined;
}
