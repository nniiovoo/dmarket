// PaymentAuth draft-order helper (Phase I.3).
//
// `buildPaymentAuthDraft` packages everything the buyer's wallet needs to
// produce an EIP-712 PaymentAuth signature for v3.2's
// `createAndPayWithAuth`. The fields mirror the on-chain struct exactly;
// the EIP-712 domain mirrors the contract's `EIP712("ChainUsEscrowERC20",
// "3.2")` constructor.
//
// We read the buyer's current `authNonces` on-chain so the draft is
// already aligned with what the contract expects. /sign/[id] also
// re-checks the nonce right before signing — a stale nonce can occur if
// the buyer signs an unrelated draft between the time the agent issued
// this one and the time the wallet pops up.

import { createPublicClient, http, getAddress, type Address } from "viem";
import { arbitrumSepolia } from "viem/chains";

import { escrowMarketplaceERC20Abi } from "@/lib/contractsV3_2";

export const PAYMENT_AUTH_DOMAIN_NAME = "ChainUsEscrowERC20";
export const PAYMENT_AUTH_DOMAIN_VERSION = "3.2";

export const PAYMENT_AUTH_TYPES = {
  PaymentAuth: [
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "paymentToken", type: "address" },
    { name: "productId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
} as const;

export interface PaymentAuthMessage {
  buyer: Address;
  seller: Address;
  paymentToken: Address;
  productId: string; // uint256 stringified
  amount: string; // uint256 stringified
  nonce: string; // uint256 stringified
  deadline: string; // unix-seconds stringified
}

export interface PaymentAuthDraft {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: typeof PAYMENT_AUTH_TYPES;
  primaryType: "PaymentAuth";
  message: PaymentAuthMessage;
}

function rpcUrlForChain(chainId: number): string {
  if (chainId === arbitrumSepolia.id) {
    const url =
      process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL;
    if (!url) throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");
    return url;
  }
  throw new Error(`Unsupported chainId for v3.2 draft-order: ${chainId}`);
}

export async function readAuthNonce(
  chainId: number,
  marketplaceAddress: Address,
  buyer: Address
): Promise<bigint> {
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrlForChain(chainId)) });
  const nonce = (await client.readContract({
    address: marketplaceAddress,
    abi: escrowMarketplaceERC20Abi,
    functionName: "authNonces",
    args: [buyer]
  })) as bigint;
  return nonce;
}

export interface BuildDraftInput {
  buyer: Address;
  seller: Address;
  paymentToken: Address;
  productId: bigint;
  amount: bigint;
  chainId: number;
  marketplaceAddress: Address;
  ttlSeconds: number;
  /// Optional injection point for tests — when omitted we read from chain.
  readNonce?: (chainId: number, marketplace: Address, buyer: Address) => Promise<bigint>;
  /// Optional override for "now" so tests are deterministic.
  now?: () => number;
}

export async function buildPaymentAuthDraft(input: BuildDraftInput): Promise<PaymentAuthDraft> {
  const nonceReader = input.readNonce ?? readAuthNonce;
  const nonce = await nonceReader(input.chainId, input.marketplaceAddress, input.buyer);
  const nowMs = (input.now ?? Date.now)();
  const deadlineSec = Math.floor(nowMs / 1000) + input.ttlSeconds;

  return {
    domain: {
      name: PAYMENT_AUTH_DOMAIN_NAME,
      version: PAYMENT_AUTH_DOMAIN_VERSION,
      chainId: input.chainId,
      verifyingContract: getAddress(input.marketplaceAddress)
    },
    types: PAYMENT_AUTH_TYPES,
    primaryType: "PaymentAuth",
    message: {
      buyer: getAddress(input.buyer),
      seller: getAddress(input.seller),
      paymentToken: getAddress(input.paymentToken),
      productId: input.productId.toString(),
      amount: input.amount.toString(),
      nonce: nonce.toString(),
      deadline: deadlineSec.toString()
    }
  };
}
