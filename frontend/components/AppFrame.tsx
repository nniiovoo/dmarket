"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId } from "wagmi";

import { NewOrderBadge } from "@/components/seller/NewOrderBadge";
import { WalletButton } from "@/components/WalletButton";
import { fetchSellerOrders } from "@/lib/api/seller";
import { hasMarketplace } from "@/lib/contracts";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/products", label: "Products" },
  { href: "/create", label: "Create Order" },
  { href: "/seller", label: "Seller Dashboard" },
  { href: "/settings", label: "Settings" },
  { href: "/seller/new", label: "Sell" },
  { href: "/admin", label: "Admin" }
];

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const seller = address?.toLowerCase();
  const sellerBadgeQuery = useQuery({
    queryKey: ["seller", "orders", seller, chainId, "Paid", "nav"],
    queryFn: () => fetchSellerOrders({ seller: seller ?? "", chainId, status: "Paid", limit: 100 }),
    enabled: isConnected && seller !== undefined && hasMarketplace(chainId),
    refetchInterval: 15_000
  });
  const sellerBadgeCount = sellerBadgeQuery.data?.orders.length ?? 0;
  const connectedOnlyHrefs = new Set(["/seller", "/settings"]);
  const visibleNavItems = isConnected ? navItems : navItems.filter((item) => !connectedOnlyHrefs.has(item.href));

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/" className="text-lg font-semibold text-slate-950">
              Escrow Marketplace
            </Link>
            <p className="text-sm text-slate-500">v2 testnet dApp</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2">
            {visibleNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  isActivePath(pathname, item.href) ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {item.label}
                {item.href === "/seller" ? <NewOrderBadge count={sellerBadgeCount} /> : null}
              </Link>
            ))}
            <WalletButton />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

function isActivePath(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
