import { prisma } from "./db";

export type ApiEvidence = {
  chainId: number;
  onChainOrderId: string;
  evidenceIndex: number;
  party: string;
  evidenceURI: string;
  contentHash: string;
  marketplaceDeliveredAtSnapshot: string;
  submittedAt: string;
  submittedBlock: string;
  submittedTxHash: string;
  oracleRequestId: string | null;
  oracleQueryStatus: "pending" | "fulfilled" | "failed" | null;
  oracleDelivered: boolean | null;
  oracleDeliveredTimestamp: string | null;
  oracleError: string | null;
  oracleFulfilledAt: string | null;
  oracleFulfilledBlock: string | null;
  oracleFulfilledTxHash: string | null;
};

export type EvidenceListResponse = {
  evidence: ApiEvidence[];
};

export async function listEvidenceForOrder(
  chainId: number,
  onChainOrderId: string
): Promise<EvidenceListResponse> {
  const rows = await prisma.evidence.findMany({
    where: { chainId, onChainOrderId },
    orderBy: { evidenceIndex: "asc" }
  });

  return {
    evidence: rows.map(serializeEvidence)
  };
}

function serializeEvidence(row: {
  chainId: number;
  onChainOrderId: string;
  evidenceIndex: number;
  party: string;
  evidenceURI: string;
  contentHash: string;
  marketplaceDeliveredAtSnapshot: bigint;
  submittedAt: Date;
  submittedBlock: bigint;
  submittedTxHash: string;
  oracleRequestId: string | null;
  oracleQueryStatus: string | null;
  oracleDelivered: boolean | null;
  oracleDeliveredTimestamp: bigint | null;
  oracleError: string | null;
  oracleFulfilledAt: Date | null;
  oracleFulfilledBlock: bigint | null;
  oracleFulfilledTxHash: string | null;
}): ApiEvidence {
  return {
    chainId: row.chainId,
    onChainOrderId: row.onChainOrderId,
    evidenceIndex: row.evidenceIndex,
    party: row.party,
    evidenceURI: row.evidenceURI,
    contentHash: row.contentHash,
    marketplaceDeliveredAtSnapshot: row.marketplaceDeliveredAtSnapshot.toString(),
    submittedAt: row.submittedAt.toISOString(),
    submittedBlock: row.submittedBlock.toString(),
    submittedTxHash: row.submittedTxHash,
    oracleRequestId: row.oracleRequestId,
    oracleQueryStatus: row.oracleQueryStatus as ApiEvidence["oracleQueryStatus"],
    oracleDelivered: row.oracleDelivered,
    oracleDeliveredTimestamp: row.oracleDeliveredTimestamp?.toString() ?? null,
    oracleError: row.oracleError,
    oracleFulfilledAt: row.oracleFulfilledAt?.toISOString() ?? null,
    oracleFulfilledBlock: row.oracleFulfilledBlock?.toString() ?? null,
    oracleFulfilledTxHash: row.oracleFulfilledTxHash
  };
}
