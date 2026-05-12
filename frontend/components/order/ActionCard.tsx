import type { ReactNode } from "react";

import type { AvailableAction } from "@/lib/orderPermissions";

export function ActionCard({ action, children }: { action: AvailableAction; children: ReactNode }) {
  return (
    <div className={`rounded-lg border p-4 ${panelStyle(action.variant)}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-semibold text-slate-950">{action.label}</p>
          <p className="mt-1 text-sm text-slate-600">{action.description}</p>
        </div>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function panelStyle(variant: AvailableAction["variant"]) {
  if (variant === "danger") {
    return "border-red-100 bg-red-50/40";
  }
  if (variant === "primary") {
    return "border-blue-100 bg-blue-50/40";
  }
  return "border-slate-200 bg-slate-50";
}
