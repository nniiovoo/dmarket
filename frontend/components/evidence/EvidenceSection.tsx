"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { isEvidenceRegistryDeployed } from "@/lib/contracts";
import type { ApiOrder } from "@/lib/orders";

import { EvidenceTimeline } from "./EvidenceTimeline";
import { SubmitEvidenceDialog } from "./SubmitEvidenceDialog";

const ELIGIBLE_STATUSES = new Set(["Paid", "Shipped", "Disputed"]);

export function EvidenceSection({ order }: { order: ApiOrder }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  if (!isEvidenceRegistryDeployed(order.chainId)) {
    return null;
  }

  const canSubmit = ELIGIBLE_STATUSES.has(order.status);

  return (
    <Card
      title="Dispute evidence"
      action={
        canSubmit && (
          <button
            onClick={() => setDialogOpen(true)}
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700"
          >
            Submit evidence
          </button>
        )
      }
    >
      <EvidenceTimeline
        chainId={order.chainId}
        onChainOrderId={order.onChainOrderId}
        refreshKey={refreshKey}
      />

      {dialogOpen && (
        <SubmitEvidenceDialog
          order={order}
          onClose={() => setDialogOpen(false)}
          onSubmitted={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </Card>
  );
}
