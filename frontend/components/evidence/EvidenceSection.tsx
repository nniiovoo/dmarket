"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/Card";
import { isEvidenceRegistryDeployed, isKlerosAdapterDeployed } from "@/lib/contracts";
import type { ApiOrder } from "@/lib/orders";

import { EscalateToKlerosButton } from "./EscalateToKlerosButton";
import { EvidenceTimeline } from "./EvidenceTimeline";
import { SubmitEvidenceDialog } from "./SubmitEvidenceDialog";

const ELIGIBLE_STATUSES = new Set(["Paid", "Shipped", "Disputed"]);

export function EvidenceSection({ order }: { order: ApiOrder }) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pollUntil, setPollUntil] = useState<number | undefined>();
  const evidenceRegistryDeployed = isEvidenceRegistryDeployed(order.chainId);
  const klerosAdapterDeployed = isKlerosAdapterDeployed(order.chainId);

  if (!evidenceRegistryDeployed && !klerosAdapterDeployed) {
    return null;
  }

  const canSubmit = ELIGIBLE_STATUSES.has(order.status);

  return (
    <Card
      title="Dispute evidence"
      action={
        evidenceRegistryDeployed && canSubmit && (
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
        pollUntil={pollUntil}
      />

      <EscalateToKlerosButton
        order={order}
        onEscalated={() => setRefreshKey((k) => k + 1)}
      />

      {dialogOpen && (
        <SubmitEvidenceDialog
          order={order}
          onClose={() => setDialogOpen(false)}
          onSubmitted={() => {
            setRefreshKey((k) => k + 1);
            setPollUntil(Date.now() + 1_500);
            void queryClient.invalidateQueries({
              queryKey: ["evidence", order.chainId, order.onChainOrderId]
            });
          }}
        />
      )}
    </Card>
  );
}
