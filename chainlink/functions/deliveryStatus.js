// ChainUs delivery status oracle source.
// Runs inside the Chainlink Functions DON sandbox.
//
// Inputs:
//   args[0]              = orderId (decimal string), passed by the contract.
//   secrets.TRACK17_KEY  = 17track API token, uploaded via DON Secrets.
//   secrets.TRACKING_LOOKUP_URL (optional) = ChainUs public endpoint that
//     resolves orderId -> { carrier, trackingNumber }. If unset, we fall back
//     to secrets.TEST_TRACKING_NUMBER so we can smoke-test before the backend
//     is publicly reachable.
//
// Output (ABI-encoded):
//   (bool delivered, uint64 deliveredTimestamp)
//
// 17track gettrackinfo status codes (latest_event.status_code):
//   0  = NotFound       10 = InTransit
//   20 = Expired        30 = PickUp
//   35 = Undelivered    40 = Delivered
//   50 = AlertException
//
// Only code 40 yields delivered=true. The recorded timestamp is the
// latest_event.time_iso (seconds since epoch, capped at uint64).

const orderId = args[0];
if (!orderId) {
  throw Error("Missing orderId");
}

const trackToken = secrets.TRACK17_KEY;
if (!trackToken) {
  throw Error("Missing TRACK17_KEY secret");
}

// Resolve tracking number. Prefer the public lookup endpoint; fall back to a
// test secret so we can run end-to-end before the backend is deployed.
let trackingNumber;
let carrier;

if (secrets.TRACKING_LOOKUP_URL) {
  const lookupUrl = secrets.TRACKING_LOOKUP_URL.replace("{orderId}", orderId);
  const lookupResponse = await Functions.makeHttpRequest({
    url: lookupUrl,
    method: "GET",
    timeout: 9000
  });

  if (lookupResponse.error || !lookupResponse.data) {
    throw Error(`Tracking lookup failed: ${lookupResponse.error ?? "no data"}`);
  }

  trackingNumber = lookupResponse.data.trackingNumber;
  carrier = lookupResponse.data.carrier;

  if (!trackingNumber) {
    // Tracking not yet recorded by seller; report not-delivered without error.
    return encodeResult(false, 0);
  }
} else {
  // Explicit opt-in required. Without ALLOW_TEST_FALLBACK=1 the function
  // throws — preventing accidental mainnet deploys from using a shared
  // test tracking number across every order.
  if (secrets.ALLOW_TEST_FALLBACK !== "1") {
    throw Error("TRACKING_LOOKUP_URL is required (set ALLOW_TEST_FALLBACK=1 for testnet only)");
  }

  trackingNumber = secrets.TEST_TRACKING_NUMBER;
  carrier = secrets.TEST_CARRIER;

  if (!trackingNumber) {
    throw Error("ALLOW_TEST_FALLBACK is set but TEST_TRACKING_NUMBER is missing");
  }
}

// Query 17track. Carrier code is optional — if provided, 17track skips
// carrier auto-detection (faster + saves a quota point).
const requestBody = [
  carrier
    ? { number: trackingNumber, carrier: Number(carrier) }
    : { number: trackingNumber }
];

const trackResponse = await Functions.makeHttpRequest({
  url: "https://api.17track.net/track/v2.2/gettrackinfo",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "17token": trackToken
  },
  data: requestBody,
  timeout: 9000
});

if (trackResponse.error) {
  throw Error(`17track request failed: ${trackResponse.error}`);
}

const payload = trackResponse.data;
if (!payload || payload.code !== 0) {
  throw Error(`17track returned code ${payload?.code ?? "unknown"}: ${payload?.message ?? "no message"}`);
}

const accepted = payload?.data?.accepted ?? [];
const rejected = payload?.data?.rejected ?? [];

if (accepted.length === 0) {
  // Rejected often means quota exhausted or invalid tracking number — surface it.
  const reason = rejected[0]?.error?.message ?? "no accepted results";
  throw Error(`17track rejected: ${reason}`);
}

const latestEvent = accepted[0]?.track_info?.latest_event;
const statusCode = latestEvent?.status_code ?? 0;

if (statusCode !== 40) {
  // Not delivered yet. Returning (false, 0) so the contract leaves
  // deliveredAt unchanged.
  return encodeResult(false, 0);
}

const isoTime = latestEvent?.time_iso ?? latestEvent?.time_utc;
const epochSeconds = isoTime ? Math.floor(new Date(isoTime).getTime() / 1000) : Math.floor(Date.now() / 1000);

// uint64 max is 2^64-1, comfortably above any plausible epoch seconds.
return encodeResult(true, epochSeconds);

// abi.encode(bool, uint64) -> 64 bytes total, two 32-byte slots.
function encodeResult(delivered, timestamp) {
  const buf = new Uint8Array(64);
  buf[31] = delivered ? 1 : 0;

  let ts = BigInt(timestamp);
  for (let i = 63; i >= 56 && ts > 0n; i--) {
    buf[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }

  return buf;
}
