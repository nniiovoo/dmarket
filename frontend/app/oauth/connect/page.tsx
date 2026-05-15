"use client";

import { Suspense, useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";

import { useSiweAuth } from "@/lib/useSiweAuth";
import { WalletButton } from "@/components/WalletButton";

// OAuth landing page — user lands here from /oauth/authorize.
//
// Flow:
//   1. User connects a wallet (WalletButton).
//   2. User clicks "Sign in with Ethereum" — the existing useSiweAuth hook
//      handles the nonce + signature + /api/auth/siwe/verify roundtrip.
//   3. On success, we POST the OAuth params + the SIWE session cookie to
//      /api/oauth/grant. That endpoint mints a one-time auth code and
//      hands back the redirect URL we should navigate to.
//
// We deliberately *don't* embed the client's name in any HTML that the
// client controls — clientId is shown verbatim from the env-allowlist
// `name` field, so an attacker can't spoof "ChainUs" branding by passing
// a malicious client_id (they'd need to be in the allowlist to begin with).

interface OAuthQuery {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

function readQuery(params: URLSearchParams): OAuthQuery {
  return {
    clientId: params.get("client_id") ?? "",
    redirectUri: params.get("redirect_uri") ?? "",
    state: params.get("state") ?? "",
    scope: params.get("scope") ?? "",
    codeChallenge: params.get("code_challenge") ?? "",
    codeChallengeMethod: params.get("code_challenge_method") ?? ""
  };
}

function ConnectInner() {
  const params = useSearchParams();
  const query = readQuery(params);
  const { isConnected, address } = useAccount();
  const { status: siweStatus, error: siweError, sessionAddress, signIn, matchesConnected } = useSiweAuth();
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  const missingParams = !query.clientId || !query.redirectUri;
  const ready = matchesConnected;

  const grant = useCallback(async () => {
    setGranting(true);
    setGrantError(null);
    try {
      const res = await fetch("/api/oauth/grant", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: query.clientId,
          redirectUri: query.redirectUri,
          state: query.state || undefined,
          scope: query.scope || undefined,
          codeChallenge: query.codeChallenge || undefined,
          codeChallengeMethod: query.codeChallengeMethod || undefined
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        setGrantError(`${body.error ?? "grant_failed"}: ${body.reason ?? res.status}`);
        return;
      }
      const data = (await res.json()) as { redirectUrl: string };
      window.location.assign(data.redirectUrl);
    } catch (err) {
      setGrantError(err instanceof Error ? err.message : String(err));
    } finally {
      setGranting(false);
    }
  }, [query]);

  const signInAndGrant = useCallback(async () => {
    const result = await signIn();
    if (result.ok) await grant();
  }, [grant, signIn]);

  if (missingParams) {
    return (
      <main className="mx-auto max-w-md px-6 py-12">
        <h1 className="text-2xl font-semibold">Authorization request invalid</h1>
        <p className="mt-4 text-sm text-gray-600">
          The link is missing required OAuth parameters. Please retry from the application you came from.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold">Connect your ChainUs wallet</h1>
      <p className="mt-2 text-sm text-gray-600">
        <span className="font-medium">{query.clientId}</span> would like to act as a shopping assistant on your
        behalf. The agent can search products and prepare unsigned orders. <strong>You always sign each
        purchase in your own wallet</strong> — the agent never holds private keys.
      </p>

      <div className="mt-6 space-y-4">
        <div className="rounded-md border border-gray-200 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Step 1 — wallet</div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-sm">
              {isConnected ? `Connected: ${address?.slice(0, 6)}…${address?.slice(-4)}` : "Not connected"}
            </span>
            <WalletButton />
          </div>
        </div>

        <div className="rounded-md border border-gray-200 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Step 2 — Sign in</div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-sm">
              {sessionAddress ? `Signed in as ${sessionAddress.slice(0, 6)}…${sessionAddress.slice(-4)}` : "Not signed in"}
            </span>
            <button
              type="button"
              onClick={() => void signInAndGrant()}
              disabled={!isConnected || siweStatus === "signing" || siweStatus === "verifying" || granting}
              className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {siweStatus === "signing" || siweStatus === "verifying"
                ? "Signing…"
                : matchesConnected
                ? "Signed"
                : "Sign in with Ethereum"}
            </button>
          </div>
          {siweError ? <div className="mt-2 text-xs text-red-600">{siweError}</div> : null}
        </div>

        <div className="rounded-md border border-gray-200 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Step 3 — Return</div>
          <p className="mt-2 text-sm text-gray-600">
            {granting
              ? "Granting access and redirecting…"
              : ready
              ? "Returning you to the application…"
              : "Complete steps 1 and 2 above. The agent will get a scoped token bound to this address. You can revoke it any time by signing out of your wallet on chainus.org."}
          </p>
          {grantError ? <div className="mt-2 text-xs text-red-600">{grantError}</div> : null}
        </div>
      </div>
    </main>
  );
}

export default function OAuthConnectPage() {
  return (
    <Suspense fallback={<div className="p-12 text-sm text-gray-500">Loading…</div>}>
      <ConnectInner />
    </Suspense>
  );
}
