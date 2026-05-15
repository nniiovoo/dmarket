import type { Abi, Address } from "viem";
import { arbitrumSepolia } from "wagmi/chains";

import escrowMarketplaceERC20AbiJson from "@/abi/EscrowMarketplaceERC20.json";
import klerosAdapterV3_2AbiJson from "@/abi/KlerosV2DisputeAdapterV3_2.json";
import reputationRegistryAbiJson from "@/abi/ReputationRegistry.json";

export const escrowMarketplaceERC20Abi = escrowMarketplaceERC20AbiJson as Abi;
export const klerosAdapterV3_2Abi = klerosAdapterV3_2AbiJson as Abi;
export const reputationRegistryAbi = reputationRegistryAbiJson as Abi;

export type AcceptedToken = {
  symbol: string;
  address: Address;
  decimals: number;
  label: string;
};

export type V3_2ContractAddresses = {
  marketplace: Address;
  reputation?: Address;
  klerosAdapter?: Address;
};

const ARB_SEPOLIA_MOCK_USD = process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_MOCK_USD_ADDRESS as Address | undefined;

export const ACCEPTED_TOKENS_BY_CHAIN: Record<number, AcceptedToken[]> = {
  [arbitrumSepolia.id]: ARB_SEPOLIA_MOCK_USD
    ? [
        {
          symbol: "mUSD",
          address: ARB_SEPOLIA_MOCK_USD,
          decimals: 6,
          label: "Mock USD (testnet)"
        }
      ]
    : []
};

export function getV3_2ContractAddresses(chainId: number | undefined): V3_2ContractAddresses | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;

  const marketplace = process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS as Address | undefined;
  if (!marketplace) return undefined;

  return {
    marketplace,
    reputation: process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS as Address | undefined,
    klerosAdapter: process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_KLEROS_ADAPTER_ADDRESS as Address | undefined
  };
}

export function getAcceptedTokens(chainId: number | undefined): AcceptedToken[] {
  if (chainId === undefined) return [];
  return ACCEPTED_TOKENS_BY_CHAIN[chainId] ?? [];
}

export function hasV3_2OnChain(chainId: number | undefined): boolean {
  return getV3_2ContractAddresses(chainId) !== undefined;
}
