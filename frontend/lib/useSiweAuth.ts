"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { buildSiweMessageClient } from "@/lib/siweMessage";

export type SiweStatus = "idle" | "checking" | "signing" | "verifying" | "ready" | "error";

export function useSiweAuth() {
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [status, setStatus] = useState<SiweStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);

  // On mount, check if we already have a server session.
  useEffect(() => {
    let cancelled = false;
    setStatus("checking");
    fetch("/api/auth/siwe/me", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { address: string | null }) => {
        if (cancelled) return;
        setSessionAddress(data.address);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("ready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!isConnected || !address) {
      const msg = "Connect your wallet first.";
      setError(msg);
      setStatus("error");
      return { ok: false, error: msg };
    }
    setError(null);
    setStatus("signing");

    try {
      const nonceRes = await fetch("/api/auth/siwe/nonce", { method: "POST" });
      if (!nonceRes.ok) {
        const text = await nonceRes.text().catch(() => "");
        const msg = `Nonce fetch failed (${nonceRes.status}): ${text.slice(0, 200)}`;
        setError(msg);
        setStatus("error");
        return { ok: false, error: msg };
      }
      const nonceBody = (await nonceRes.json().catch(() => ({}))) as { nonce?: string };
      if (!nonceBody.nonce) {
        const msg = "Nonce endpoint returned no nonce.";
        setError(msg);
        setStatus("error");
        return { ok: false, error: msg };
      }

      const issuedAt = new Date();
      const expirationTime = new Date(issuedAt.getTime() + 10 * 60_000);
      const message = buildSiweMessageClient({
        domain: window.location.host,
        address,
        statement: "Authenticate to view dispute evidence on ChainUs.",
        uri: window.location.origin,
        version: "1",
        chainId: chainId ?? 1,
        nonce: nonceBody.nonce,
        issuedAt: issuedAt.toISOString(),
        expirationTime: expirationTime.toISOString()
      });

      let signature: `0x${string}`;
      try {
        signature = await signMessageAsync({ message });
      } catch (err) {
        const msg = `Wallet signing rejected or failed: ${err instanceof Error ? err.message : String(err)}`;
        setError(msg);
        setStatus("error");
        return { ok: false, error: msg };
      }

      setStatus("verifying");
      const verifyRes = await fetch("/api/auth/siwe/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message, signature })
      });
      if (!verifyRes.ok) {
        const body = (await verifyRes.json().catch(() => ({}))) as { error?: string };
        const msg = `Verification failed (${verifyRes.status}): ${body.error ?? "unknown"}`;
        setError(msg);
        setStatus("error");
        return { ok: false, error: msg };
      }
      const verified = (await verifyRes.json()) as { address: string };
      setSessionAddress(verified.address);
      setStatus("ready");
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
      return { ok: false, error: msg };
    }
  }, [address, chainId, isConnected, signMessageAsync]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/siwe/logout", { method: "POST", credentials: "include" });
    setSessionAddress(null);
  }, []);

  const matchesConnected =
    sessionAddress !== null &&
    address !== undefined &&
    sessionAddress.toLowerCase() === address.toLowerCase();

  return {
    status,
    error,
    sessionAddress,
    signIn,
    signOut,
    matchesConnected
  };
}
