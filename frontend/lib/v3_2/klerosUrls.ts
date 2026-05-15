import { arbitrumSepolia } from "wagmi/chains";

// Per-chain Kleros V2 court UI base. Future mainnet entry uses v2.kleros.builders
// (without the -testnet subdomain). We hardcode rather than derive from chain
// metadata because Kleros's UI host is project-managed, not wallet-discoverable.
const KLEROS_CASE_BASE: Record<number, string> = {
  [arbitrumSepolia.id]: "https://v2-testnet.kleros.builders/#/cases/"
};

export function getKlerosCaseUrl(chainId: number | undefined, klerosDisputeId: bigint | undefined): string | undefined {
  if (chainId === undefined || klerosDisputeId === undefined) return undefined;
  const base = KLEROS_CASE_BASE[chainId];
  if (!base) return undefined;
  return `${base}${klerosDisputeId.toString()}`;
}
