import type { Abi, Address } from "viem";
import { arbitrumSepolia, polygonAmoy, sepolia } from "wagmi/chains";

import escrowMarketplaceV2AbiJson from "@/abi/EscrowMarketplaceV2.json";
import escrowVaultAbiJson from "@/abi/EscrowVault.json";
import escrowMarketplaceV3AbiJson from "@/abi/EscrowMarketplaceV3.json";
import escrowVaultV3AbiJson from "@/abi/EscrowVaultV3.json";
import evidenceRegistryV3AbiJson from "@/abi/EvidenceRegistryV3.json";

export const escrowMarketplaceV2Abi = escrowMarketplaceV2AbiJson as Abi;
export const escrowVaultAbi = escrowVaultAbiJson as Abi;
export const escrowMarketplaceV3Abi = escrowMarketplaceV3AbiJson as Abi;
export const escrowVaultV3Abi = escrowVaultV3AbiJson as Abi;
export const evidenceRegistryV3Abi = evidenceRegistryV3AbiJson as Abi;

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
};

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
      evidenceRegistry: process.env.NEXT_PUBLIC_V3_SEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined
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
      evidenceRegistry: process.env.NEXT_PUBLIC_V3_ARBITRUMSEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined
    };
  }

  return undefined;
}

export function isSupportedChain(chainId: number | undefined) {
  return getContractAddresses(chainId) !== undefined;
}

export function isV3Supported(chainId: number | undefined) {
  return getV3ContractAddresses(chainId) !== undefined;
}

export function isEvidenceRegistryDeployed(chainId: number | undefined) {
  const addrs = getV3ContractAddresses(chainId);
  return addrs?.evidenceRegistry !== undefined;
}
