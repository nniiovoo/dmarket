import type { Metadata } from "next";

import { AppFrame } from "@/components/AppFrame";
import { IndexerLagBanner } from "@/components/IndexerLagBanner";
import { Providers } from "@/app/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Escrow Marketplace",
  description: "Interactive v2 escrow marketplace testnet dApp"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <IndexerLagBanner />
          <AppFrame>{children}</AppFrame>
        </Providers>
      </body>
    </html>
  );
}
