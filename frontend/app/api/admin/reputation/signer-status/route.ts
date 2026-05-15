import { NextResponse } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import { arbitrumSepolia } from "viem/chains";

import { isAdmin } from "@/lib/adminAuth";
import { getSession } from "@/lib/auth/siwe";
import { prisma } from "@/lib/db";
import { reputationRegistryAbi } from "@/lib/contractsV3_2";

export const dynamic = "force-dynamic";

// Read-only admin endpoint that aggregates a few pieces the admin panel
// can't easily get from wagmi/react-query alone:
//   - latest PublishedAttestation row from the DB
//   - current on-chain signer's ETH balance (the admin panel reads
//     signer()/pendingSigner() via wagmi, but balance needs a chain RPC
//     and we want to avoid mounting a separate hook for it)
export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!isAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const registryAddress =
    process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS ??
    process.env.V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS;
  if (!registryAddress) {
    return NextResponse.json({ error: "ReputationRegistry not configured" }, { status: 503 });
  }

  const rpcUrl =
    process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL;

  let signerBalanceWei: string | null = null;
  try {
    const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
    const signer = (await client.readContract({
      address: registryAddress as Address,
      abi: reputationRegistryAbi,
      functionName: "signer"
    })) as Address;
    const balance = await client.getBalance({ address: signer });
    signerBalanceWei = balance.toString();
  } catch {
    // Chain unavailable — surface null balance, admin UI handles missing data.
  }

  const latest = await prisma.publishedAttestation.findFirst({
    where: { txHash: { not: null } },
    orderBy: { publishedAt: "desc" },
    select: { subject: true, version: true, score: true, publishedAt: true, txHash: true }
  });

  return NextResponse.json({
    registryAddress,
    signerBalanceWei,
    latest: latest
      ? {
          subject: latest.subject,
          version: latest.version,
          score: latest.score,
          publishedAt: latest.publishedAt?.toISOString() ?? null,
          txHash: latest.txHash
        }
      : null
  });
}
