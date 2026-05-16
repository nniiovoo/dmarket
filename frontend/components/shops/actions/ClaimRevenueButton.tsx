"use client";

import { useState } from "react";
import type { Address } from "viem";
import { formatEther, formatUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { Card } from "@/components/Card";
import { decodeDappError, type DappError } from "@/lib/errors";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getAcceptedTokens } from "@/lib/contractsV3_2";
import {
  getV3_3DistributorAddress,
  revenueDistributorAbi,
  NATIVE_TOKEN
} from "@/lib/contractsV3_3";
import { useEnsureChain } from "@/lib/useEnsureChain";

interface Props {
  shopId: number;
  onConfirmed?: () => void;
}

interface ClaimableRow {
  symbol: string;
  address: Address;
  decimals: number;
  pending: bigint;
}

/// Shareholder-only panel that reads pendingClaim(shopId, token,
/// holder) for the native asset + every accepted ERC-20, then renders
/// a per-token claim button. Empty pending values are hidden so the
/// card doesn't show four "0 ETH" rows.
export function ClaimRevenueButton({ shopId, onConfirmed }: Props) {
  const { address: connected } = useAccount();
  const publicClient = usePublicClient({ chainId: PRIMARY_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { ensure } = useEnsureChain();

  const distributorAddress = getV3_3DistributorAddress(PRIMARY_CHAIN_ID);
  const acceptedTokens = getAcceptedTokens(PRIMARY_CHAIN_ID);

  const nativePending = useReadContract({
    address: distributorAddress,
    abi: revenueDistributorAbi,
    functionName: "pendingClaim",
    args: connected ? [BigInt(shopId), NATIVE_TOKEN, connected] : undefined,
    query: { enabled: Boolean(distributorAddress && connected) }
  });
  // Stable reads per token — useReadContract requires literal index
  // for hook ordering. We only support mUSD on testnet today, so
  // listing it explicitly is fine. (When the token allowlist grows,
  // switch to useReadContracts.)
  const firstErc20 = acceptedTokens[0];
  const firstErc20Pending = useReadContract({
    address: distributorAddress,
    abi: revenueDistributorAbi,
    functionName: "pendingClaim",
    args:
      connected && firstErc20
        ? [BigInt(shopId), firstErc20.address, connected]
        : undefined,
    query: { enabled: Boolean(distributorAddress && connected && firstErc20) }
  });

  const [busyToken, setBusyToken] = useState<Address | undefined>();
  const [txHash, setTxHash] = useState<string | undefined>();
  const [error, setError] = useState<DappError | undefined>();

  if (!distributorAddress || !connected) return null;

  const rows: ClaimableRow[] = [];
  const nativeBig = (nativePending.data as bigint | undefined) ?? 0n;
  if (nativeBig > 0n) {
    rows.push({ symbol: "ETH", address: NATIVE_TOKEN, decimals: 18, pending: nativeBig });
  }
  if (firstErc20) {
    const v = (firstErc20Pending.data as bigint | undefined) ?? 0n;
    if (v > 0n) {
      rows.push({
        symbol: firstErc20.symbol,
        address: firstErc20.address,
        decimals: firstErc20.decimals,
        pending: v
      });
    }
  }

  async function claim(tokenAddr: Address) {
    setError(undefined);
    setTxHash(undefined);
    setBusyToken(tokenAddr);
    try {
      try {
        await ensure(PRIMARY_CHAIN_ID);
      } catch (err) {
        throw err;
      }
      const hash = await writeContractAsync({
        address: distributorAddress!,
        abi: revenueDistributorAbi,
        functionName: "claim",
        args: [BigInt(shopId), tokenAddr]
      });
      setTxHash(hash);
      await publicClient?.waitForTransactionReceipt({ hash });
      onConfirmed?.();
      void nativePending.refetch();
      void firstErc20Pending.refetch();
    } catch (err) {
      setError(decodeDappError(err));
    } finally {
      setBusyToken(undefined);
    }
  }

  return (
    <Card title="Claim revenue">
      {rows.length === 0 ? (
        <p className="text-sm text-slate-600">
          Nothing claimable for this shop right now. Revenue accrues when buyers complete orders
          on the v3.3 marketplace (1 % of every completed order is split pro-rata across
          shareholders).
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const display =
              row.decimals === 18 ? `${formatEther(row.pending)} ETH` : `${formatUnits(row.pending, row.decimals)} ${row.symbol}`;
            const busy = busyToken?.toLowerCase() === row.address.toLowerCase();
            return (
              <li
                key={row.address}
                className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
              >
                <div>
                  <p className="font-medium text-slate-900">{display}</p>
                  <p className="text-xs text-slate-500">
                    {row.symbol === "ETH" ? "Native asset" : `Token ${row.address.slice(0, 6)}…`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void claim(row.address)}
                  disabled={busy}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                >
                  {busy ? "Claiming…" : `Claim ${row.symbol}`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {txHash ? (
        <p className="mt-3 text-[10px] text-slate-500">last tx {txHash.slice(0, 10)}…</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-red-600">
          {error.title}: {error.message}
        </p>
      ) : null}
    </Card>
  );
}
