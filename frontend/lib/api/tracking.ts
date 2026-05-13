export type TrackingEvent = {
  time: string;
  description: string;
  location: string | null;
  statusCode: number;
};

export type TrackingState = "ok" | "stale" | "no-tracking" | "unavailable";

export type TrackingResponse =
  | {
      state: "ok" | "stale";
      cached: boolean;
      warning?: string;
      trackingNumber: string;
      status: string;
      statusCode: number;
      latestEventAt: string | null;
      events: TrackingEvent[];
      lastFetchedAt: string;
    }
  | {
      state: "no-tracking" | "unavailable";
      message: string;
    };

export async function fetchTracking(chainId: number, onChainOrderId: string): Promise<TrackingResponse> {
  const response = await fetch(`/api/tracking/${chainId}/${onChainOrderId}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error ?? "Failed to load tracking");
  }

  return data as TrackingResponse;
}
