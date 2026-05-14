import { arbitrumSepolia, polygonAmoy, sepolia } from "wagmi/chains";

export const PRIMARY_CHAIN = arbitrumSepolia;
export const PRIMARY_CHAIN_ID = arbitrumSepolia.id;

export const supportedChains = [arbitrumSepolia, sepolia, polygonAmoy] as const;

export const LEGACY_CHAIN_IDS: number[] = [sepolia.id, polygonAmoy.id];

export function isLegacyChain(chainId: number | undefined): boolean {
  return chainId !== undefined && LEGACY_CHAIN_IDS.includes(chainId);
}

export function isPrimaryChain(chainId: number | undefined): boolean {
  return chainId === PRIMARY_CHAIN_ID;
}

export const explorerByChainId: Record<number, string> = {
  [sepolia.id]: "https://sepolia.etherscan.io",
  [polygonAmoy.id]: "https://amoy.polygonscan.com",
  [arbitrumSepolia.id]: "https://sepolia.arbiscan.io"
};

export const faucetByChainId: Record<number, string> = {
  [sepolia.id]: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
  [polygonAmoy.id]: "https://faucet.polygon.technology/",
  [arbitrumSepolia.id]: "https://www.alchemy.com/faucets/arbitrum-sepolia"
};

export function getExplorerTxUrl(chainId: number | undefined, txHash: string | undefined) {
  if (chainId === undefined || txHash === undefined) {
    return undefined;
  }

  const explorer = explorerByChainId[chainId];
  return explorer === undefined ? undefined : `${explorer}/tx/${txHash}`;
}

export function getExplorerAddressUrl(chainId: number | undefined, address: string | undefined) {
  if (chainId === undefined || address === undefined) {
    return undefined;
  }

  const explorer = explorerByChainId[chainId];
  return explorer === undefined ? undefined : `${explorer}/address/${address}`;
}

export function getFaucetUrl(chainId: number | undefined) {
  return chainId === undefined ? undefined : faucetByChainId[chainId];
}
