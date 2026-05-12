import { polygonAmoy, sepolia } from "wagmi/chains";

export const supportedChains = [sepolia, polygonAmoy] as const;

export const explorerByChainId: Record<number, string> = {
  [sepolia.id]: "https://sepolia.etherscan.io",
  [polygonAmoy.id]: "https://amoy.polygonscan.com"
};

export const faucetByChainId: Record<number, string> = {
  [sepolia.id]: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
  [polygonAmoy.id]: "https://faucet.polygon.technology/"
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
