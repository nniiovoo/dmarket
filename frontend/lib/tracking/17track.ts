// 17track gettrackinfo client. Calls the public REST API with the seller's
// API key (TRACK17_API_KEY env). The same JS source ships into the Chainlink
// DON sandbox via chainlink/functions/deliveryStatus.js — keep the two in
// sync if the upstream schema changes.

// Status codes documented at https://api.17track.net/
//   0  = NotFound       10 = InTransit
//   20 = Expired        30 = PickUp
//   35 = Undelivered    40 = Delivered
//   50 = AlertException

export type Track17StatusCode = 0 | 10 | 20 | 30 | 35 | 40 | 50;

export const STATUS_LABEL: Record<number, string> = {
  0: "Unknown",
  10: "InTransit",
  20: "Expired",
  30: "Pickup",
  35: "Undelivered",
  40: "Delivered",
  50: "Exception"
};

export type TrackEvent = {
  time: string; // ISO-8601
  description: string;
  location: string | null;
  statusCode: number;
};

export type Track17Result = {
  status: string;
  statusCode: number;
  latestEventAt: Date | null;
  events: TrackEvent[];
};

const ENDPOINT = "https://api.17track.net/track/v2.2/gettrackinfo";

export async function fetchTrackingFrom17track(trackingNumber: string, carrierCode?: number): Promise<Track17Result> {
  const apiKey = process.env.TRACK17_API_KEY;

  if (!apiKey) {
    throw new Error("TRACK17_API_KEY is not configured");
  }

  const body = [
    carrierCode !== undefined && Number.isFinite(carrierCode)
      ? { number: trackingNumber, carrier: carrierCode }
      : { number: trackingNumber }
  ];

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "17token": apiKey
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`17track HTTP ${response.status}`);
  }

  const payload = (await response.json()) as Track17Response;

  if (!payload || payload.code !== 0) {
    throw new Error(`17track returned code ${payload?.code ?? "unknown"}: ${payload?.message ?? "no message"}`);
  }

  const accepted = payload.data?.accepted ?? [];
  const rejected = payload.data?.rejected ?? [];

  if (accepted.length === 0) {
    const reason = rejected[0]?.error?.message ?? "no accepted results";
    throw new Error(`17track rejected: ${reason}`);
  }

  const trackInfo = accepted[0]?.track_info;
  const latestEvent = trackInfo?.latest_event;
  const statusCode = latestEvent?.status_code ?? 0;
  const status = STATUS_LABEL[statusCode] ?? "Unknown";

  const latestEventAt = latestEvent?.time_iso ? new Date(latestEvent.time_iso) : null;

  const events: TrackEvent[] = (trackInfo?.tracking?.providers ?? [])
    .flatMap((provider) => provider.events ?? [])
    .filter((event): event is Track17Event => event !== undefined && typeof event.time_iso === "string")
    .map((event) => ({
      time: event.time_iso!,
      description: event.description ?? "",
      location: event.location ?? null,
      statusCode: event.status_code ?? 0
    }))
    // Most-recent first.
    .sort((a, b) => (a.time < b.time ? 1 : -1));

  return { status, statusCode, latestEventAt, events };
}

// --- Subset of the 17track v2.2 response we read from. ---

type Track17Response = {
  code?: number;
  message?: string;
  data?: {
    accepted?: Array<{
      number?: string;
      track_info?: {
        latest_event?: Track17Event;
        tracking?: {
          providers?: Array<{
            events?: Track17Event[];
          }>;
        };
      };
    }>;
    rejected?: Array<{
      error?: { message?: string };
    }>;
  };
};

type Track17Event = {
  time_iso?: string;
  time_utc?: string;
  description?: string;
  location?: string;
  status_code?: number;
};
