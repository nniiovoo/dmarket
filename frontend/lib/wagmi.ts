"use client";

import { createConfig, http } from "wagmi";
import { arbitrumSepolia, polygonAmoy, sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

import { supportedChains } from "@/lib/chains";

export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

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
    [sepolia.id]: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || undefined),
    [polygonAmoy.id]: http(process.env.NEXT_PUBLIC_AMOY_RPC_URL || undefined),
    [arbitrumSepolia.id]: http(process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL || undefined)
  }
});
