"use client";

import { carrierName } from "@/lib/carriers";

export function TrackingLink({
  carrier,
  trackingNumber,
  trackingUrl,
  shippingNote
}: {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippingNote: string | null;
}) {
  if (!trackingNumber) {
    return <p className="text-sm text-slate-500">卖家未提供物流信息。</p>;
  }

  return (
    <div className="space-y-3 text-sm">
      <Info label="Carrier" value={carrierName(carrier)} />
      <Info label="Tracking number" value={trackingNumber} />
      {shippingNote ? <Info label="Note" value={shippingNote} /> : null}
      {trackingUrl ? (
        <a
          href={trackingUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Open tracking
        </a>
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase text-slate-400">{label}</p>
      <p className="break-all text-slate-800">{value}</p>
    </div>
  );
}
