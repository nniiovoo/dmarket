import type { ApiEvidence, EvidenceListResponse } from "@/lib/evidence";

export type { ApiEvidence, EvidenceListResponse };

export async function fetchEvidenceForOrder(
  chainId: number,
  onChainOrderId: string
): Promise<EvidenceListResponse> {
  const response = await fetch(`/api/orders/${chainId}/${onChainOrderId}/evidence`);
  const data = (await response.json()) as EvidenceListResponse | { error?: string };

  if (!response.ok) {
    const message = "error" in data && data.error ? data.error : "Failed to fetch evidence";
    throw new Error(message);
  }

  return data as EvidenceListResponse;
}
