import type { PrismaClient } from "@prisma/client";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { reputationRegistryAbi } from "../contractsV3_2";
import { computeSellerScore, type SellerScore } from "./score";

// EIP-712 schema must match the on-chain typehash exactly. See
// contracts/v3_2/ReputationRegistry.sol's ATTESTATION_TYPEHASH for the
// authoritative definition; tests in test/V3_2_ReputationRegistry.test.ts
// pin the same struct shape.
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "subject", type: "address" },
    { name: "score", type: "uint16" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "version", type: "uint8" }
  ]
} as const;

export const REPUTATION_DOMAIN_NAME = "ChainUsReputation";
export const REPUTATION_DOMAIN_VERSION = "1";

const DEFAULT_EXPIRY_DAYS = 30;
const MAX_VERSION = 255; // uint8 in the contract

export interface AttestationPayload {
  subject: Address;
  score: number;
  issuedAt: number; // unix seconds
  expiry: number; // unix seconds
  version: number;
}

export interface IssuedAttestation {
  attestation: AttestationPayload;
  signature: Hex;
  // Snapshot of the score that drove the attestation (signed value rounds
  // to int but the breakdown is useful for ops + the read API).
  derivedScore: SellerScore;
}

export interface IssueOptions {
  expiryDays?: number;
  registryAddress?: Address;
  chainId?: number;
  // Allow callers (cron / smoke / refresh API) to inject a different signer
  // for testing; defaults to REPUTATION_SIGNER_PRIVATE_KEY from env.
  signerPrivateKey?: Hex;
  // When set, skip recomputing score and use this one. Lets the cron run
  // computeSellerScore once and re-use the result if it issues retries.
  precomputedScore?: SellerScore;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function getRegistryAddress(override?: Address): Address {
  if (override) return getAddress(override);
  const raw =
    process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS ??
    process.env.V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS;
  if (!raw) throw new Error("V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS is not set");
  return getAddress(raw);
}

function getReputationChainId(override?: number): number {
  return override ?? arbitrumSepolia.id;
}

// Reads the stored `latest[subject].version` from the on-chain registry.
// Returns 0 when nothing has been attested yet — the next valid version
// is therefore `current + 1` (the contract rejects `att.version <= stored`
// once any row exists, but treats `version == 1` as the first record).
async function readStoredVersion(subject: Address, registryAddress: Address): Promise<number> {
  const rpcUrl =
    process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error("ARBITRUM_SEPOLIA_RPC_URL is not set");

  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
  const stored = (await client.readContract({
    address: registryAddress,
    abi: reputationRegistryAbi,
    functionName: "latest",
    args: [subject]
  })) as readonly [Address, number, bigint, bigint, number];

  // Tuple shape mirrors the Attestation struct order:
  //   (subject, score, issuedAt, expiry, version)
  // We only need version here.
  return stored[4];
}

export async function issueAttestation(
  seller: Address,
  db: PrismaClient,
  options: IssueOptions = {}
): Promise<IssuedAttestation> {
  const subject = getAddress(seller);
  const registryAddress = getRegistryAddress(options.registryAddress);
  const chainId = getReputationChainId(options.chainId);
  const expiryDays = options.expiryDays ?? DEFAULT_EXPIRY_DAYS;

  const derivedScore = options.precomputedScore ?? (await computeSellerScore(subject, db));

  const storedVersion = await readStoredVersion(subject, registryAddress);
  const nextVersion = storedVersion + 1;
  if (nextVersion > MAX_VERSION) {
    throw new Error(
      `Attestation version exhausted for ${subject}: stored=${storedVersion}, max=${MAX_VERSION}. ` +
        `The uint8 cap means a single subject only supports 255 attestations before redesigning the schema.`
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiry = issuedAt + expiryDays * 86400;

  const attestation: AttestationPayload = {
    subject,
    score: derivedScore.raw,
    issuedAt,
    expiry,
    version: nextVersion
  };

  const signerKey = (options.signerPrivateKey ?? requireEnv("REPUTATION_SIGNER_PRIVATE_KEY")) as Hex;
  const account = privateKeyToAccount(signerKey);

  const signature = await account.signTypedData({
    domain: {
      name: REPUTATION_DOMAIN_NAME,
      version: REPUTATION_DOMAIN_VERSION,
      chainId,
      verifyingContract: registryAddress
    },
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message: {
      subject: attestation.subject,
      score: attestation.score,
      issuedAt: BigInt(attestation.issuedAt),
      expiry: BigInt(attestation.expiry),
      version: attestation.version
    }
  });

  return { attestation, signature, derivedScore };
}
