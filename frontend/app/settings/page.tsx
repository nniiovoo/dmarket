"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { fetchEmailStatus, updateEmail } from "@/lib/api/user";

export default function SettingsPage() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const walletAddress = address?.toLowerCase();
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<"idle" | "signing" | "saving">("idle");
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const statusQuery = useQuery({
    queryKey: ["user", "email", walletAddress],
    queryFn: () => fetchEmailStatus(walletAddress ?? ""),
    enabled: walletAddress !== undefined
  });
  const validEmail = email.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  async function submit() {
    if (!walletAddress || !email || !validEmail) {
      return;
    }

    setError(undefined);
    setMessage(undefined);
    setPhase("signing");

    try {
      const signedMessage = `ChainUs:BindEmail:${email}:${Date.now()}:${walletAddress}`;
      const signature = await signMessageAsync({ message: signedMessage });
      setPhase("saving");
      await updateEmail({ walletAddress, email, signature, signedMessage });
      setMessage("Email updated.");
      setEmail("");
      void statusQuery.refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update email");
      setPhase("idle");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-950">Settings</h1>
        <p className="mt-2 text-slate-600">Manage wallet-level ChainUs preferences.</p>
      </div>

      <Card title="Notification email">
        {!isConnected || !walletAddress ? (
          <EmptyState title="Connect wallet" body="Connect a wallet to bind a notification email." />
        ) : (
          <div className="space-y-4">
            {statusQuery.isLoading ? (
              <SkeletonLine className="w-56" />
            ) : (
              <p className="text-sm text-slate-600">
                Current status:{" "}
                {statusQuery.data?.isBound ? `Bound to ${statusQuery.data.maskedEmail}` : "No email bound"}
              </p>
            )}
            <label className="block">
              <span className="text-sm font-medium text-slate-700">New email</span>
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
              />
            </label>
            {!validEmail ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">Enter a valid email address.</p> : null}
            {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
            {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!email || !validEmail || phase !== "idle"}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {phase === "signing" ? "Sign in wallet..." : phase === "saving" ? "Updating..." : "Update email"}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
