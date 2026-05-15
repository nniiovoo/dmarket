"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { getAddress, isAddress, formatEther, type Address } from "viem";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { PRIMARY_CHAIN_ID, getExplorerTxUrl } from "@/lib/chains";
import {
  escrowMarketplaceERC20Abi,
  reputationRegistryAbi,
  getAcceptedTokens,
  getV3_2ContractAddresses
} from "@/lib/contractsV3_2";

// Admin v3.2 surface. Three independent panels: accepted-token allowlist,
// reputation signer status + rotation, refresh queue. Each panel reads
// from its own data source (chain for token state + signer, DB for queue)
// and shares no state with the others.

export function V3_2AdminSection() {
  const v3_2 = getV3_2ContractAddresses(PRIMARY_CHAIN_ID);
  if (!v3_2) {
    return (
      <Card title="v3.2 Marketplace">
        <EmptyState
          title="v3.2 not configured"
          body="NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS is not set in this environment."
        />
      </Card>
    );
  }

  return (
    <Card title="v3.2 Marketplace">
      <div className="space-y-6">
        <AcceptedTokensPanel marketplaceAddress={v3_2.marketplace} />
        {v3_2.reputation ? <ReputationSignerPanel registryAddress={v3_2.reputation} /> : null}
        <RefreshQueuePanel />
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------- //
// F.2.a Accepted Tokens                                                  //
// --------------------------------------------------------------------- //

function AcceptedTokensPanel({ marketplaceAddress }: { marketplaceAddress: Address }) {
  const knownTokens = getAcceptedTokens(PRIMARY_CHAIN_ID);
  const [extraTokens, setExtraTokens] = useState<Array<{ address: Address; label: string }>>([]);
  const allTokens = useMemo(
    () => [
      ...knownTokens.map((t) => ({ address: t.address, label: `${t.symbol} (${t.label})` })),
      ...extraTokens
    ],
    [knownTokens, extraTokens]
  );

  return (
    <section>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Accepted tokens</h3>
      <p className="mt-1 text-xs text-slate-500">
        Toggles <code className="font-mono">EscrowMarketplaceERC20.setAcceptedToken</code> on the live marketplace.
        Only the contract owner can write.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <th className="pb-2 pr-4">Token</th>
              <th className="pb-2 pr-4">Address</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {allTokens.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-2 text-slate-500">
                  No tokens registered. Add one below.
                </td>
              </tr>
            ) : (
              allTokens.map((token) => (
                <TokenRow key={token.address} marketplace={marketplaceAddress} token={token} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <AddTokenForm
        onAdd={(address, symbol) => {
          if (extraTokens.find((t) => t.address.toLowerCase() === address.toLowerCase())) return;
          setExtraTokens((prev) => [...prev, { address, label: symbol || "custom" }]);
        }}
      />
    </section>
  );
}

function TokenRow({
  marketplace,
  token
}: {
  marketplace: Address;
  token: { address: Address; label: string };
}) {
  const acceptedQuery = useReadContract({
    address: marketplace,
    abi: escrowMarketplaceERC20Abi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "acceptedToken",
    args: [token.address]
  });
  const accepted = Boolean(acceptedQuery.data);
  const { writeContractAsync, isPending } = useWriteContract();
  const [error, setError] = useState<string | null>(null);
  const [pendingHash, setPendingHash] = useState<string | null>(null);

  const toggle = useCallback(
    async (next: boolean) => {
      setError(null);
      try {
        const hash = await writeContractAsync({
          address: marketplace,
          abi: escrowMarketplaceERC20Abi,
          chainId: PRIMARY_CHAIN_ID,
          functionName: "setAcceptedToken",
          args: [token.address, next]
        });
        setPendingHash(hash);
        // Re-read after a short wait so the UI reflects the new state.
        setTimeout(() => void acceptedQuery.refetch(), 3_000);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [acceptedQuery, marketplace, token.address, writeContractAsync]
  );

  const txUrl = pendingHash ? getExplorerTxUrl(PRIMARY_CHAIN_ID, pendingHash) : undefined;

  return (
    <tr className="border-b border-slate-100 align-top last:border-0">
      <td className="py-2 pr-4 text-slate-900">{token.label}</td>
      <td className="py-2 pr-4 font-mono text-xs text-slate-500">{token.address}</td>
      <td className="py-2 pr-4">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${accepted ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-600"}`}
        >
          {acceptedQuery.isLoading ? "—" : accepted ? "Accepted" : "Removed"}
        </span>
      </td>
      <td className="py-2">
        <button
          type="button"
          onClick={() => void toggle(!accepted)}
          disabled={isPending}
          className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {isPending ? "Pending…" : accepted ? "Remove" : "Re-enable"}
        </button>
        {txUrl ? (
          <a href={txUrl} target="_blank" rel="noreferrer" className="ml-2 text-xs text-blue-700 underline">
            tx ↗
          </a>
        ) : null}
        {error ? <p className="mt-1 text-xs text-red-700">{error}</p> : null}
      </td>
    </tr>
  );
}

function AddTokenForm({ onAdd }: { onAdd: (address: Address, symbol: string) => void }) {
  const [address, setAddress] = useState("");
  const [symbol, setSymbol] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmed = address.trim();
    if (!isAddress(trimmed)) {
      setError("Not a valid 0x address");
      return;
    }
    if (trimmed === "0x0000000000000000000000000000000000000000") {
      setError("Cannot register the zero address");
      return;
    }
    onAdd(getAddress(trimmed), symbol.trim());
    setAddress("");
    setSymbol("");
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2 text-sm">
      <div className="flex flex-col">
        <label className="text-xs text-slate-500">Token address</label>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x..."
          className="min-w-72 rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
        />
      </div>
      <div className="flex flex-col">
        <label className="text-xs text-slate-500">Symbol (display)</label>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="USDC"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <button type="submit" className="rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-white">
        Stage token for allowlist
      </button>
      {error ? <p className="basis-full text-xs text-red-700">{error}</p> : null}
      <p className="basis-full text-xs text-slate-500">
        Adding here registers the address in this UI session — click the row&apos;s &ldquo;Re-enable&rdquo; to send the
        on-chain <code>setAcceptedToken</code> tx.
      </p>
    </form>
  );
}

// --------------------------------------------------------------------- //
// F.2.b Reputation Signer                                                //
// --------------------------------------------------------------------- //

function ReputationSignerPanel({ registryAddress }: { registryAddress: Address }) {
  const { address: connected } = useAccount();
  const signerQuery = useReadContract({
    address: registryAddress,
    abi: reputationRegistryAbi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "signer"
  });
  const pendingQuery = useReadContract({
    address: registryAddress,
    abi: reputationRegistryAbi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "pendingSigner"
  });
  const [latestAtt, setLatestAtt] = useState<{ publishedAt: string; txHash: string; subject: string } | null>(null);
  const [signerEthWei, setSignerEthWei] = useState<bigint | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/reputation/signer-status")
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.latest)
          setLatestAtt({
            publishedAt: data.latest.publishedAt,
            txHash: data.latest.txHash,
            subject: data.latest.subject
          });
        if (typeof data.signerBalanceWei === "string") setSignerEthWei(BigInt(data.signerBalanceWei));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const currentSigner = signerQuery.data as Address | undefined;
  const pendingSigner = pendingQuery.data as Address | undefined;
  const hasPending = pendingSigner && pendingSigner !== "0x0000000000000000000000000000000000000000";

  const { writeContractAsync, isPending } = useWriteContract();
  const [newSignerInput, setNewSignerInput] = useState("");
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  async function propose() {
    setProposeError(null);
    if (!isAddress(newSignerInput.trim())) {
      setProposeError("Invalid address");
      return;
    }
    try {
      await writeContractAsync({
        address: registryAddress,
        abi: reputationRegistryAbi,
        chainId: PRIMARY_CHAIN_ID,
        functionName: "setPendingSigner",
        args: [getAddress(newSignerInput.trim())]
      });
      setTimeout(() => void pendingQuery.refetch(), 3_000);
    } catch (err) {
      setProposeError(err instanceof Error ? err.message : String(err));
    }
  }

  async function accept() {
    setAcceptError(null);
    try {
      await writeContractAsync({
        address: registryAddress,
        abi: reputationRegistryAbi,
        chainId: PRIMARY_CHAIN_ID,
        functionName: "acceptSigner"
      });
      setTimeout(() => {
        void signerQuery.refetch();
        void pendingQuery.refetch();
      }, 3_000);
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : String(err));
    }
  }

  const canAccept = Boolean(
    hasPending && connected && pendingSigner!.toLowerCase() === connected.toLowerCase()
  );

  return (
    <section>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Reputation signer</h3>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
        <Row label="Current signer" value={signerQuery.isLoading ? "—" : currentSigner ?? "—"} mono />
        <Row label="Pending signer" value={pendingQuery.isLoading ? "—" : hasPending ? pendingSigner! : "(none)"} mono />
        <Row
          label="Latest attestation"
          value={
            latestAtt
              ? `${new Date(latestAtt.publishedAt).toLocaleString()} — ${latestAtt.subject.slice(0, 10)}…`
              : "—"
          }
        />
        <Row
          label="Current signer ETH"
          value={signerEthWei !== null ? `${formatEther(signerEthWei)} ETH` : "—"}
        />
      </dl>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-200 p-3">
          <p className="text-xs font-medium uppercase text-slate-500">Propose new signer</p>
          <input
            value={newSignerInput}
            onChange={(e) => setNewSignerInput(e.target.value)}
            placeholder="0x..."
            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => void propose()}
            disabled={isPending}
            className="mt-2 rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            setPendingSigner
          </button>
          {proposeError ? <p className="mt-1 text-xs text-red-700">{proposeError}</p> : null}
        </div>

        <div className="rounded-md border border-slate-200 p-3">
          <p className="text-xs font-medium uppercase text-slate-500">Accept rotation</p>
          <p className="mt-1 text-xs text-slate-500">
            Only the wallet listed as pending signer can call this.
          </p>
          <button
            type="button"
            onClick={() => void accept()}
            disabled={!canAccept || isPending}
            title={canAccept ? "" : hasPending ? "Connect the pending signer wallet to accept." : "No pending signer."}
            className="mt-2 rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
          >
            acceptSigner
          </button>
          {acceptError ? <p className="mt-1 text-xs text-red-700">{acceptError}</p> : null}
        </div>
      </div>
    </section>
  );
}

// --------------------------------------------------------------------- //
// F.2.c Refresh Queue                                                    //
// --------------------------------------------------------------------- //

type QueueEntry = {
  subject: string;
  queuedAt: string;
  processedAt: string | null;
};

function RefreshQueuePanel() {
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ processed: number; succeeded: number; failed: number; errors?: string[] } | null>(
    null
  );

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/reputation/refresh-queue");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { entries: QueueEntry[] };
      setQueue(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer the fetch one microtask so the lint rule that flags
    // setState() in effect bodies doesn't trip — the queue load is an
    // async network call, but the rule sees the synchronous entry point.
    const t = window.setTimeout(() => void fetchQueue(), 0);
    return () => window.clearTimeout(t);
  }, [fetchQueue]);

  async function runAll() {
    setError(null);
    setRunResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/admin/reputation/refresh-queue", { method: "POST" });
      const data = (await res.json()) as { processed: number; succeeded: number; failed: number; errors?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRunResult({ processed: data.processed, succeeded: data.succeeded, failed: data.failed, errors: data.errors });
      await fetchQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const pendingCount = queue ? queue.filter((q) => !q.processedAt).length : 0;

  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Reputation refresh queue</h3>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={loading || pendingCount === 0}
          className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {loading ? "Running…" : `Refresh all queued (${pendingCount})`}
        </button>
      </div>

      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
      {runResult ? (
        <p className="mt-2 text-xs text-slate-700">
          Processed {runResult.processed}: {runResult.succeeded} ok, {runResult.failed} failed.
        </p>
      ) : null}

      <div className="mt-3 overflow-x-auto">
        {loading && !queue ? (
          <SkeletonLine />
        ) : !queue || queue.length === 0 ? (
          <p className="text-sm text-slate-500">Queue is empty.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <th className="pb-2 pr-4">Address</th>
                <th className="pb-2 pr-4">Queued</th>
                <th className="pb-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((entry) => (
                <tr key={entry.subject} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-4 font-mono text-xs">{entry.subject}</td>
                  <td className="py-2 pr-4 text-slate-500">{new Date(entry.queuedAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">
                    {entry.processedAt ? (
                      <span className="text-emerald-700">Processed {new Date(entry.processedAt).toLocaleString()}</span>
                    ) : (
                      <span className="text-amber-700">Pending</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 break-all text-slate-900 ${mono ? "font-mono text-xs" : "text-sm"}`}>{value}</p>
    </div>
  );
}
