// Seeds the Evidence table from on-chain EvidenceRegistry state.
//
// Reads on-chain records directly (no eth_getLogs — free-tier RPC limits
// log range to 10 blocks). URIs are hardcoded from the test deploy script
// since they're not stored on-chain.
//
// Usage:
//   cd frontend && npx tsx scripts/seedV3Evidence.ts                  # defaults to sepolia
//   SEED_CHAIN=arbitrumSepolia npx tsx scripts/seedV3Evidence.ts
//   npx tsx scripts/seedV3Evidence.ts --chain arbitrumSepolia 1 2

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address, type Chain } from "viem";
import { arbitrumSepolia, sepolia } from "viem/chains";
import { PrismaClient } from "@prisma/client";
import evidenceRegistryV3AbiJson from "../abi/EvidenceRegistryV3.json" with { type: "json" };

const SUPPORTED: Record<string, { chain: Chain; envPrefix: string; rpcEnv: string }> = {
  sepolia: { chain: sepolia, envPrefix: "SEPOLIA", rpcEnv: "SEPOLIA_RPC_URL" },
  arbitrumSepolia: { chain: arbitrumSepolia, envPrefix: "ARBITRUMSEPOLIA", rpcEnv: "ARBITRUM_SEPOLIA_RPC_URL" }
};

function parseArgs() {
  const argv = process.argv.slice(2);
  let chainName = process.env.SEED_CHAIN ?? "sepolia";
  const orderArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--chain") {
      chainName = argv[i + 1] ?? chainName;
      i++;
    } else {
      orderArgs.push(argv[i]!);
    }
  }
  return { chainName, orderArgs };
}

function loadEnv() {
  for (const file of [".env", ".env.local"]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const key = t.slice(0, i);
      let value = t.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}
loadEnv();

// URIs from scripts/sepoliaTest/02_lifecycleAndEvidence.ts. Only used to
// populate the indexer's evidenceURI column for orders seeded out-of-band.
// Going forward, the live indexer fills this from on-chain Evidence events.
const KNOWN_URIS: Record<string, Record<number, string>> = {
  "2": {
    0: "ipfs://QmBuyerEvidenceTestSepolia001",
    1: "ipfs://QmSellerCounterEvidenceTestSepolia002",
    2: "ipfs://QmOracleQueryEvidence003"
  }
};

async function main() {
  const { chainName, orderArgs } = parseArgs();
  const cfg = SUPPORTED[chainName];
  if (!cfg) {
    throw new Error(`Unsupported chain: ${chainName}. Supported: ${Object.keys(SUPPORTED).join(", ")}`);
  }

  const registryAddr =
    (process.env[`NEXT_PUBLIC_V3_${cfg.envPrefix}_EVIDENCE_REGISTRY_ADDRESS`] as Address | undefined) ??
    (process.env[`V3_${cfg.envPrefix}_EVIDENCE_REGISTRY_ADDRESS`] as Address | undefined);
  const rpc = process.env[`NEXT_PUBLIC_${cfg.rpcEnv}`] ?? process.env[cfg.rpcEnv];
  if (!registryAddr) throw new Error(`Missing NEXT_PUBLIC_V3_${cfg.envPrefix}_EVIDENCE_REGISTRY_ADDRESS`);
  if (!rpc) throw new Error(`Missing ${cfg.rpcEnv}`);

  const orderIds = (orderArgs.length > 0 ? orderArgs : ["1", "2", "3"]).map((s) => BigInt(s));

  console.log("Seeding V3 evidence into DB (on-chain reads only)");
  console.log(`  chain:    ${chainName}`);
  console.log(`  registry: ${registryAddr}`);
  console.log(`  orderIds: ${orderIds.join(", ")}`);

  const client = createPublicClient({ chain: cfg.chain, transport: http(rpc) });
  const prisma = new PrismaClient();
  const chainId = cfg.chain.id;
  const now = new Date();

  for (const orderId of orderIds) {
    const evCount = (await client.readContract({
      address: registryAddr,
      abi: evidenceRegistryV3AbiJson,
      functionName: "getEvidenceCount",
      args: [orderId]
    })) as bigint;

    console.log(`\n→ order ${orderId}: ${evCount} evidence record(s)`);
    if (evCount === 0n) continue;

    for (let i = 0n; i < evCount; i++) {
      const rec = (await client.readContract({
        address: registryAddr,
        abi: evidenceRegistryV3AbiJson,
        functionName: "getEvidence",
        args: [orderId, i]
      })) as {
        party: Address;
        submittedAt: bigint;
        contentHash: `0x${string}`;
        marketplaceDeliveredAtSnapshot: bigint;
        oracleRequestId: `0x${string}`;
      };

      // Oracle result (if query was fired)
      let oracleQueryStatus: string | null = null;
      let oracleDelivered: boolean | null = null;
      let oracleDeliveredTimestamp: bigint | null = null;
      const hasOracleReq = rec.oracleRequestId !== "0x0000000000000000000000000000000000000000000000000000000000000000";
      if (hasOracleReq) {
        const oracleRes = (await client.readContract({
          address: registryAddr,
          abi: evidenceRegistryV3AbiJson,
          functionName: "oracleResults",
          args: [orderId, i]
        })) as { fulfilled: boolean; delivered: boolean; deliveredTimestamp: bigint };
        oracleQueryStatus = oracleRes.fulfilled ? "fulfilled" : "pending";
        if (oracleRes.fulfilled) {
          oracleDelivered = oracleRes.delivered;
          oracleDeliveredTimestamp = oracleRes.deliveredTimestamp;
        }
      }

      const uri = KNOWN_URIS[orderId.toString()]?.[Number(i)] ?? "";
      const submittedAt = new Date(Number(rec.submittedAt) * 1000);
      const idx = Number(i);

      await prisma.evidence.upsert({
        where: {
          chainId_onChainOrderId_evidenceIndex: {
            chainId,
            onChainOrderId: orderId.toString(),
            evidenceIndex: idx
          }
        },
        create: {
          chainId,
          onChainOrderId: orderId.toString(),
          evidenceIndex: idx,
          party: rec.party.toLowerCase(),
          evidenceURI: uri,
          contentHash: rec.contentHash,
          marketplaceDeliveredAtSnapshot: rec.marketplaceDeliveredAtSnapshot,
          submittedAt,
          submittedBlock: 0n,
          submittedTxHash: "seed-script",
          oracleRequestId: hasOracleReq ? rec.oracleRequestId : null,
          oracleQueryStatus,
          oracleDelivered,
          oracleDeliveredTimestamp,
          oracleError: null,
          oracleFulfilledAt: oracleQueryStatus === "fulfilled" ? now : null,
          oracleFulfilledBlock: null,
          oracleFulfilledTxHash: null
        },
        update: {
          party: rec.party.toLowerCase(),
          evidenceURI: uri,
          contentHash: rec.contentHash,
          marketplaceDeliveredAtSnapshot: rec.marketplaceDeliveredAtSnapshot,
          submittedAt,
          oracleRequestId: hasOracleReq ? rec.oracleRequestId : null,
          oracleQueryStatus,
          oracleDelivered,
          oracleDeliveredTimestamp,
          oracleFulfilledAt: oracleQueryStatus === "fulfilled" ? now : null
        }
      });

      console.log(
        `  [${idx}] party=${rec.party.slice(0, 10)}... uri="${uri.slice(0, 40)}" oracle=${oracleQueryStatus ?? "none"}  ✓`
      );
    }
  }

  await prisma.$disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
