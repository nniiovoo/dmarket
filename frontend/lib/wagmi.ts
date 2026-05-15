"use client";

import { createConfig, fallback, http } from "wagmi";
import { arbitrumSepolia, polygonAmoy, sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

import { supportedChains } from "@/lib/chains";

export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

// Primary transport goes through our own /api/rpc proxy. Falling through to
// a couple of public RPCs keeps the UI usable when:
//   - the proxy is down / not deployed yet
//   - our paid RPC key hit a rate limit
//   - some node is geographically slow for the user
// The order matters: wagmi tries them in declaration order and only moves on
// after a transport errors. Keep proxy first so we get the per-IP rate
// limiting + observability for the common path, then public nodes as a
// safety net.
function transportWithFallback(proxyPath: string, publicUrls: string[]) {
  return fallback([
    http(proxyPath),
    ...publicUrls.map((u) => http(u))
  ]);
}

export const wagmiConfig = createConfig({
  chains: supportedChains,
  connectors: [
    injected({
      shimDisconnect: true,
      target: "metaMask",
      unstable_shimAsyncInject: 1_000
    }),
    walletConnect({
      projectId: walletConnectProjectId,
      showQrModal: true,
      metadata: {
        name: "Escrow Marketplace",
        description: "Testnet escrow marketplace MVP",
        url: "http://127.0.0.1:3000",
        icons: []
      }
    })
  ],
  ssr: true,
  transports: {
    [sepolia.id]: transportWithFallback("/api/rpc/sepolia", [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://1rpc.io/sepolia"
    ]),
    [polygonAmoy.id]: transportWithFallback("/api/rpc/polygon-amoy", [
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://rpc-amoy.polygon.technology"
    ]),
    [arbitrumSepolia.id]: transportWithFallback("/api/rpc/arbitrum-sepolia", [
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia.publicnode.com"
    ])
  }
});
