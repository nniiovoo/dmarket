import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hash,
  type Hex
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { reputationRegistryAbi } from "../contractsV3_2";
import type { IssuedAttestation } from "./issuer";

export interface PublishOptions {
  registryAddress?: Address;
  // Private key used to *send* the recordAttestation tx (pays gas). When
  // omitted, defaults to RELAYER_PRIVATE_KEY then PRIVATE_KEY. Pass `null`
  // to request calldata-only (returns no hash; the caller is expected to
  // submit the tx from the user's wallet later — Phase E territory).
  relayerKey?: Hex | null;
}

export interface PublishCalldata {
  to: Address;
  data: Hex;
}

function getRegistryAddress(override?: Address): Address {
  if (override) return getAddress(override);
  const raw =
    process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS ??
    process.env.V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS;
  if (!raw) throw new Error("V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS is not set");
  return getAddress(raw);
}

function getRelayerKey(option: PublishOptions["relayerKey"]): Hex | null {
  if (option === null) return null;
  if (option) return option;
  const raw = process.env.RELAYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error("Neither relayerKey arg nor RELAYER_PRIVATE_KEY/PRIVATE_KEY env is set");
  }
  return raw.trim() as Hex;
}

function getRpcUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL;
  if (!raw) throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");
  return raw;
}

// Build the calldata for a recordAttestation call without submitting.
// Useful when the front-end wants the seller's wallet to pay gas (the
// Phase-E "self-publish" flow).
export function buildRecordAttestationCalldata(
  issued: IssuedAttestation,
  options: Pick<PublishOptions, "registryAddress"> = {}
): PublishCalldata {
  const registryAddress = getRegistryAddress(options.registryAddress);
  const data = encodeFunctionData({
    abi: reputationRegistryAbi,
    functionName: "recordAttestation",
    args: [
      {
        subject: issued.attestation.subject,
        score: issued.attestation.score,
        issuedAt: BigInt(issued.attestation.issuedAt),
        expiry: BigInt(issued.attestation.expiry),
        version: issued.attestation.version
      },
      issued.signature
    ]
  });
  return { to: registryAddress, data };
}

export async function publishAttestation(
  issued: IssuedAttestation,
  options: PublishOptions = {}
): Promise<Hash> {
  const relayerKey = getRelayerKey(options.relayerKey);
  if (relayerKey === null) {
    throw new Error(
      "publishAttestation called with relayerKey=null. Use buildRecordAttestationCalldata for calldata-only flow."
    );
  }

  const registryAddress = getRegistryAddress(options.registryAddress);
  const rpcUrl = getRpcUrl();
  const account = privateKeyToAccount(relayerKey);

  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: arbitrumSepolia, transport: http(rpcUrl), account });

  // Simulate first so a non-trivial revert (wrong version, bad signature,
  // expired) surfaces with the real error name rather than a generic gas
  // estimation failure.
  await publicClient.simulateContract({
    address: registryAddress,
    abi: reputationRegistryAbi,
    functionName: "recordAttestation",
    args: [
      {
        subject: issued.attestation.subject,
        score: issued.attestation.score,
        issuedAt: BigInt(issued.attestation.issuedAt),
        expiry: BigInt(issued.attestation.expiry),
        version: issued.attestation.version
      },
      issued.signature
    ],
    account
  });

  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: reputationRegistryAbi,
    functionName: "recordAttestation",
    args: [
      {
        subject: issued.attestation.subject,
        score: issued.attestation.score,
        issuedAt: BigInt(issued.attestation.issuedAt),
        expiry: BigInt(issued.attestation.expiry),
        version: issued.attestation.version
      },
      issued.signature
    ]
  });

  // Wait for the tx to land so the relayer's nonce lines up before the
  // next caller (cron batch, smoke loop) submits another write. Public
  // Arbitrum Sepolia RPCs occasionally lag eth_getTransactionCount and
  // back-to-back submissions otherwise pick a stale nonce.
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
