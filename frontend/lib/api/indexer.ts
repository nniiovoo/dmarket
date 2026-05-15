export type IndexerChainStatus = {
  chainId: number;
  lastIndexedBlock: string | null;
  currentBlock: string | null;
  lagBlocks: number | null;
  status: "healthy" | "syncing" | "lagging" | "unknown";
  error?: string;
};

export type IndexerV3_2Status = {
  chainId: number;
  marketplaceAddress: string;
  lastIndexedBlock: string | null;
  currentBlock: string | null;
  lagBlocks: number | null;
  lagSeconds: number | null;
  orderCount: number | null;
  status: "healthy" | "syncing" | "lagging" | "unknown";
  error?: string;
};

export type IndexerStatusResponse = {
  chains: IndexerChainStatus[];
  v3_2: IndexerV3_2Status | null;
};

export async function fetchIndexerStatus() {
  const response = await fetch("/api/indexer/status");
  const data = (await response.json()) as IndexerStatusResponse | { error?: string };

  if (!response.ok) {
    throw new Error("error" in data && data.error ? data.error : "Failed to fetch indexer status");
  }

  return data as IndexerStatusResponse;
}
