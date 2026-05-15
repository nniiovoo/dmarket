import {
  EVM,
  convertQuoteToRoute,
  createConfig,
  executeRoute,
  getQuote,
  getStatus,
  type GetStatusRequestExtended,
  type LiFiStep,
  type QuoteRequest,
  type Route
} from "@lifi/sdk";
import type { Address } from "viem";
import { getWalletClient } from "wagmi/actions";

import { wagmiConfig } from "./wagmi";

// One-time SDK initialization. Call from app entry (Providers.tsx) so it
// runs before any quote request. Idempotent.
let initialized = false;
export function initLifi() {
  if (initialized) return;
  createConfig({
    integrator: "chainus",
    providers: [
      EVM({
        getWalletClient: () => getWalletClient(wagmiConfig)
      })
    ]
  });
  initialized = true;
}

// Simplified quote we expose to UI. Hides LI.FI internals (steps, tools,
// fee bps, etc.) so UI code can mostly deal with totals.
export type CrossChainQuote = {
  fromChainId: number;
  fromTokenSymbol: string;
  fromAmount: string;
  fromAmountUsd?: string;
  toChainId: number;
  toTokenSymbol: string;
  toAmount: string;
  toAmountUsd?: string;
  estimatedDurationSec: number;
  gasCostsUsd?: string;
  feeCostsUsd?: string;
  raw: Route;
};

// Get a quote for swapping/bridging fromToken on fromChain to toToken on
// toChain. fromAddress = signer's address. toAddress = receiver address on
// the destination chain (usually the same wallet on the destination chain).
export async function getCrossChainQuote(params: {
  fromChainId: number;
  fromToken: Address;
  fromAmount: string;
  fromAddress: Address;
  toChainId: number;
  toToken: Address;
  toAddress?: Address;
}): Promise<CrossChainQuote> {
  initLifi();
  const req: QuoteRequest = {
    fromChain: params.fromChainId,
    toChain: params.toChainId,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    fromAddress: params.fromAddress,
    toAddress: params.toAddress ?? params.fromAddress
  };

  const quote = await getQuote(req);
  const route = toRoute(quote);

  return {
    fromChainId: params.fromChainId,
    fromTokenSymbol: quote.action.fromToken.symbol,
    fromAmount: quote.action.fromAmount,
    fromAmountUsd: quote.estimate.fromAmountUSD,
    toChainId: params.toChainId,
    toTokenSymbol: quote.action.toToken.symbol,
    toAmount: quote.estimate.toAmount,
    toAmountUsd: quote.estimate.toAmountUSD,
    estimatedDurationSec: quote.estimate.executionDuration,
    gasCostsUsd: quote.estimate.gasCosts?.[0]?.amountUSD,
    feeCostsUsd: quote.estimate.feeCosts?.[0]?.amountUSD,
    raw: route
  };
}

function toRoute(step: LiFiStep): Route {
  return convertQuoteToRoute(step);
}

// Execute the quoted route. Returns the final route status.
// Subscribe to onUpdate to drive a progress UI.
export async function executeBridge(params: {
  quote: CrossChainQuote;
  onUpdate?: (route: Route) => void;
}): Promise<Route> {
  initLifi();
  return executeRoute(params.quote.raw, {
    updateRouteHook: params.onUpdate
  });
}

export async function getBridgeStatus(params: GetStatusRequestExtended) {
  initLifi();
  return getStatus(params);
}
