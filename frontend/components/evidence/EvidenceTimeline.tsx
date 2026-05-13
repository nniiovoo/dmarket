"use client";

import { useEffect, useState } from "react";

import { fetchEvidenceForOrder, type ApiEvidence } from "@/lib/api/evidence";

export function EvidenceTimeline({
  chainId,
  onChainOrderId,
  refreshKey
}: {
  chainId: number;
  onChainOrderId: string;
  refreshKey?: number;
}) {
  const [evidence, setEvidence] = useState<ApiEvidence[] | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setEvidence(null);
    setError(undefined);

    fetchEvidenceForOrder(chainId, onChainOrderId)
      .then(({ evidence }) => {
        if (!cancelled) setEvidence(evidence);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load evidence");
      });

    return () => {
      cancelled = true;
    };
  }, [chainId, onChainOrderId, refreshKey]);

  if (error) {
    return <div className="text-sm text-red-600">Failed to load evidence: {error}</div>;
  }
  if (evidence === null) {
    return <div className="text-sm text-slate-500">Loading evidence…</div>;
  }
  if (evidence.length === 0) {
    return <div className="text-sm text-slate-500">No evidence submitted yet.</div>;
  }

  return (
    <ul className="space-y-3">
      {evidence.map((e) => (
        <li key={e.evidenceIndex} className="rounded border border-slate-200 p-3">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-mono">#{e.evidenceIndex}</span>
            <span>{new Date(e.submittedAt).toLocaleString()}</span>
          </div>
          <div className="mt-1 text-sm">
            <span className="text-slate-500">By</span>{" "}
            <span className="font-mono">
              {e.party.slice(0, 6)}…{e.party.slice(-4)}
            </span>
          </div>
          {e.evidenceURI ? (
            <a
              href={e.evidenceURI}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-sm text-blue-700 hover:underline"
            >
              View evidence ↗
            </a>
          ) : (
            <div className="mt-1 text-sm text-slate-400">URI not indexed</div>
          )}
          {e.oracleQueryStatus !== null && (
            <div className="mt-2 text-xs">
              <span className="text-slate-500">Oracle:</span>{" "}
              <OracleStatusBadge status={e.oracleQueryStatus} delivered={e.oracleDelivered} />
              {e.oracleError && <div className="mt-1 text-red-600">Reason: {e.oracleError}</div>}
              {e.oracleQueryStatus === "fulfilled" && e.oracleDeliveredTimestamp && (
                <div className="mt-1 text-slate-600">
                  Recorded delivered at{" "}
                  {new Date(Number(e.oracleDeliveredTimestamp) * 1000).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function OracleStatusBadge({
  status,
  delivered
}: {
  status: NonNullable<ApiEvidence["oracleQueryStatus"]>;
  delivered: boolean | null;
}) {
  if (status === "pending") return <span className="text-amber-600">Pending DON callback</span>;
  if (status === "failed") return <span className="text-red-600">Failed</span>;
  if (status === "fulfilled") {
    return (
      <span className={delivered ? "text-emerald-700" : "text-slate-600"}>
        {delivered ? "Delivery confirmed" : "Not delivered"}
      </span>
    );
  }
  return null;
}
