"use client";

// V3.1 lacks the evidence indexer that V3 relies on, so this section reads
// evidence directly off-chain via RPC:
//   - getEvidenceCount(orderId)  → how many records to list
//   - getEvidence(orderId, i)    → party, submittedAt, contentHash per index
//   - getLogs(Evidence event)    → human-readable URI (only emitted, not stored)
// The ERC-1497 `Evidence` event and the contract's `EvidenceRecorded` event
// are emitted together in submitEvidence(), so matching by orderId + order
// gives us URIs in evidenceIndex order.

import { useEffect, useMemo, useState } from "react";
import { decodeEventLog, parseAbiItem, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { Card } from "@/components/Card";
import {
  evidenceRegistryV3Abi,
  getEvidenceRegistryForOrder
} from "@/lib/contracts";
import type { ApiOrder } from "@/lib/orders";

import { SubmitEvidenceDialog } from "./SubmitEvidenceDialog";

const ELIGIBLE_STATUSES = new Set(["Paid", "Shipped", "Disputed"]);

const evidenceEventAbi = parseAbiItem(
  "event Evidence(address indexed _arbitrable, uint256 indexed _evidenceGroupID, address indexed _party, string _evidence)"
);

type EvidenceRow = {
  evidenceIndex: number;
  party: string;
  submittedAt: number; // unix seconds
  contentHash: string;
  evidenceURI?: string;
};

export function V3_1EvidenceSection({ order }: { order: ApiOrder }) {
  const { address: connectedAddress } = useAccount();
  const publicClient = usePublicClient({ chainId: order.chainId });
  const registryAddress = getEvidenceRegistryForOrder(order);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rows, setRows] = useState<EvidenceRow[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  const canSubmit = ELIGIBLE_STATUSES.has(order.status);
  const normalizedConnected = connectedAddress?.toLowerCase();
  const isParty =
    normalizedConnected !== undefined &&
    (normalizedConnected === order.buyer.toLowerCase() ||
      normalizedConnected === order.seller.toLowerCase());

  // Pull the on-chain list + URI map. Re-runs on refreshKey so the dialog can
  // poke us after a successful submitEvidence tx confirms.
  useEffect(() => {
    if (!publicClient || !registryAddress) {
      // Nothing to fetch yet. Don't clear `rows` here — that would be a
      // synchronous setState in an effect body (flagged by React 19's
      // set-state-in-effect rule). In practice registryAddress is stable
      // for a given order, so this branch only matters on the very first
      // render before wagmi resolves the public client.
      return;
    }

    let cancelled = false;

    const orderIdBig = BigInt(order.onChainOrderId);

    void (async () => {
      // Reset loadError inside the async closure so it isn't a sync setState
      // in the effect body. Visible to the user via the conditional render.
      setLoadError(undefined);

      try {
        const count = (await publicClient.readContract({
          address: registryAddress,
          abi: evidenceRegistryV3Abi,
          functionName: "getEvidenceCount",
          args: [orderIdBig]
        })) as bigint;

        const total = Number(count);
        if (cancelled) return;

        if (total === 0) {
          setRows([]);
          return;
        }

        // Read each record. These are cheap eth_calls; do them concurrently.
        const records = (await Promise.all(
          Array.from({ length: total }, (_, i) =>
            publicClient.readContract({
              address: registryAddress,
              abi: evidenceRegistryV3Abi,
              functionName: "getEvidence",
              args: [orderIdBig, BigInt(i)]
            })
          )
        )) as Array<{
          party: Address;
          submittedAt: bigint;
          contentHash: `0x${string}`;
          marketplaceDeliveredAtSnapshot: bigint;
          oracleRequestId: `0x${string}`;
        }>;

        // Pull URI strings out of the ERC-1497 Evidence event. We filter by
        // _evidenceGroupID (indexed) so the RPC server narrows efficiently.
        // If the RPC truncates / refuses the range, we degrade gracefully —
        // the UI still shows the rest of the record without a clickable URI.
        const uriByIndex = new Map<number, string>();
        try {
          const logs = await publicClient.getLogs({
            address: registryAddress,
            event: evidenceEventAbi,
            args: { _evidenceGroupID: orderIdBig },
            fromBlock: "earliest",
            toBlock: "latest"
          });

          logs.forEach((log, i) => {
            try {
              const decoded = decodeEventLog({
                abi: [evidenceEventAbi],
                data: log.data,
                topics: log.topics
              });
              const uri = (decoded.args as { _evidence?: string })._evidence;
              if (uri !== undefined) uriByIndex.set(i, uri);
            } catch {
              // skip malformed log
            }
          });
        } catch {
          // Logs unavailable (RPC range limits, etc.) — proceed without URIs.
        }

        if (cancelled) return;

        setRows(
          records.map((r, i) => ({
            evidenceIndex: i,
            party: r.party.toLowerCase(),
            submittedAt: Number(r.submittedAt),
            contentHash: r.contentHash,
            evidenceURI: uriByIndex.get(i)
          }))
        );
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to read evidence on-chain");
        setRows([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, registryAddress, order.chainId, order.onChainOrderId, refreshKey]);

  const submitButton = useMemo(() => {
    if (!registryAddress) return null;
    if (!canSubmit) return null;
    return (
      <button
        onClick={() => setDialogOpen(true)}
        disabled={!isParty}
        title={isParty ? undefined : "Only the buyer or seller can submit"}
        className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Submit evidence
      </button>
    );
  }, [registryAddress, canSubmit, isParty]);

  // Section hides entirely if the chain has no V3.1 registry configured at
  // all — there's nothing to submit to, nothing to show. We only render the
  // "registry not deployed" hint when this is a V3.1 order on a chain that
  // could plausibly have one (currently Arbitrum Sepolia).
  if (!registryAddress) {
    return (
      <Card title="Dispute evidence">
        <div className="text-sm text-slate-500">
          V3.1 EvidenceRegistry is not deployed on this chain yet.
        </div>
      </Card>
    );
  }

  return (
    <Card title="Dispute evidence" action={submitButton}>
      {loadError ? (
        <div className="text-sm text-red-600">Failed to load evidence: {loadError}</div>
      ) : rows === undefined ? (
        <div className="text-sm text-slate-500">Loading evidence…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-slate-500">No evidence submitted yet.</div>
      ) : (
        <ul className="space-y-3">
          {rows.map((e) => (
            <li key={e.evidenceIndex} className="rounded border border-slate-200 p-3">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="font-mono">#{e.evidenceIndex}</span>
                <span>{new Date(e.submittedAt * 1000).toLocaleString()}</span>
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
                <div className="mt-1 text-sm text-slate-400">URI not available from RPC logs</div>
              )}
            </li>
          ))}
        </ul>
      )}

      {dialogOpen && (
        <SubmitEvidenceDialog
          order={order}
          onClose={() => setDialogOpen(false)}
          onSubmitted={() => {
            // Re-pull the on-chain list. The tx receipt has confirmed by the
            // time the dialog calls onSubmitted, so the new record should be
            // queryable on the next refetch.
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </Card>
  );
}
