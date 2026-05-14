"use client";

import { useMemo, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { PRIMARY_CHAIN, isLegacyChain, supportedChains } from "@/lib/chains";
import { walletConnectProjectId } from "@/lib/wagmi";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function friendlyConnectError(error: unknown) {
  if (error instanceof Error) {
    if (error.message.toLowerCase().includes("provider not found")) {
      return "MetaMask extension not found. Install MetaMask or enable it for this browser.";
    }

    if (error.message.toLowerCase().includes("user rejected")) {
      return "Connection request rejected.";
    }

    return error.message;
  }

  return "Could not connect wallet.";
}

export function WalletButton() {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const [error, setError] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const [showLegacyChains, setShowLegacyChains] = useState(false);

  const metaMaskConnector = useMemo(
    () => connectors.find((connector) => connector.type === "injected") ?? connectors[0],
    [connectors]
  );
  const walletConnectConnector = useMemo(
    () => connectors.find((connector) => connector.type === "walletConnect"),
    [connectors]
  );
  const currentChain = supportedChains.find((chain) => chain.id === chainId);
  const legacyChains = supportedChains.filter((chain) => isLegacyChain(chain.id));

  async function connectMetaMask() {
    setError(undefined);

    try {
      if (!metaMaskConnector) {
        throw new Error("Provider not found");
      }

      await connectAsync({ connector: metaMaskConnector });
      setOpen(false);
    } catch (caught) {
      setError(friendlyConnectError(caught));
    }
  }

  async function connectWalletConnect() {
    setError(undefined);

    try {
      if (!walletConnectProjectId) {
        throw new Error("WalletConnect Project ID is missing");
      }

      if (!walletConnectConnector) {
        throw new Error("WalletConnect connector not found");
      }

      await connectAsync({ connector: walletConnectConnector });
      setOpen(false);
    } catch (caught) {
      setError(friendlyConnectError(caught));
    }
  }

  async function switchTo(chainIdToSwitch: number) {
    setError(undefined);

    try {
      await switchChainAsync({ chainId: chainIdToSwitch });
      setOpen(false);
    } catch (caught) {
      setError(friendlyConnectError(caught));
    }
  }

  if (isConnected && address) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-sm font-medium text-slate-950 hover:bg-slate-50"
        >
          <span className="block">{shortAddress(address)}</span>
          <span className="block text-xs text-slate-500">{currentChain?.name ?? "Unsupported network"}</span>
        </button>
        {open ? (
          <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
            <p className="text-sm font-medium text-slate-950">Wallet connected</p>
            <p className="mt-1 break-all text-xs text-slate-500">{address}</p>
            <div className="mt-3 grid gap-2">
              {[PRIMARY_CHAIN].map((chain) => (
                <button
                  key={chain.id}
                  type="button"
                  onClick={() => switchTo(chain.id)}
                  disabled={chain.id === chainId || isSwitching}
                  className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
                >
                  {chain.name}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowLegacyChains((value) => !value)}
              className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-800"
            >
              {showLegacyChains ? "Hide legacy chains" : "Show legacy chains"}
            </button>
            {showLegacyChains ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {legacyChains.map((chain) => (
                  <button
                    key={chain.id}
                    type="button"
                    onClick={() => switchTo(chain.id)}
                    disabled={chain.id === chainId || isSwitching}
                    className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    {chain.name}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => disconnect()}
              className="mt-3 w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
            >
              Disconnect
            </button>
            {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        Connect Wallet
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
          <p className="text-sm font-medium text-slate-950">Connect wallet</p>
          <p className="mt-1 text-sm text-slate-500">Use a browser extension or scan with a mobile wallet.</p>
          <button
            type="button"
            onClick={connectMetaMask}
            disabled={isPending}
            className="mt-3 w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
          >
            {isPending ? "Open MetaMask..." : "MetaMask Browser Wallet"}
          </button>
          <button
            type="button"
            onClick={connectWalletConnect}
            disabled={isPending || !walletConnectProjectId}
            className="mt-2 w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {isPending ? "Opening QR..." : "WalletConnect QR"}
          </button>
          {!walletConnectProjectId ? (
            <p className="mt-2 text-xs text-amber-700">Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable QR login.</p>
          ) : null}
          {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
