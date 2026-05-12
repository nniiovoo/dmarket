"use client";

import { useState } from "react";

import { ShipWithTrackingDialog } from "@/components/seller/ShipWithTrackingDialog";
import type { ApiOrder } from "@/lib/orders";

export function QuickShipButton({
  order,
  sellerAddress
}: {
  order: ApiOrder;
  sellerAddress: string | undefined;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-72">
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!sellerAddress}
        className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        Mark shipped
      </button>
      {open && sellerAddress ? <ShipWithTrackingDialog order={order} sellerAddress={sellerAddress} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
