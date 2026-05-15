"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { NewOrderBadge } from "@/components/seller/NewOrderBadge";
import { WalletButton } from "@/components/WalletButton";
import { fetchInboxUnreadCount } from "@/lib/api/inbox";
import { fetchSellerOrders } from "@/lib/api/seller";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { hasMarketplace } from "@/lib/contracts";
import { useSiweAuth } from "@/lib/useSiweAuth";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/products", label: "Products" },
  { href: "/create", label: "Create Order" },
  { href: "/seller", label: "Seller Dashboard" },
  { href: "/inbox", label: "Inbox" },
  { href: "/settings", label: "Settings" },
  { href: "/seller/new", label: "Sell" },
  { href: "/admin", label: "Admin" },
  { href: "/legacy", label: "Legacy" }
];

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const siwe = useSiweAuth();
  const seller = address?.toLowerCase();
  const sellerBadgeQuery = useQuery({
    queryKey: ["seller", "orders", seller, PRIMARY_CHAIN_ID, "Paid", "nav"],
    queryFn: () => fetchSellerOrders({ seller: seller ?? "", chainId: PRIMARY_CHAIN_ID, status: "Paid", limit: 100 }),
    enabled: isConnected && seller !== undefined && hasMarketplace(PRIMARY_CHAIN_ID),
    refetchInterval: 15_000
  });
  const sellerBadgeCount = sellerBadgeQuery.data?.orders.length ?? 0;

  // Total unread chat messages across all the user's threads. Only meaningful
  // once SIWE'd in — the API 401s otherwise, so don't bother polling.
  const inboxBadgeQuery = useQuery({
    queryKey: ["inbox", "unread", siwe.sessionAddress ?? ""],
    queryFn: fetchInboxUnreadCount,
    enabled: siwe.sessionAddress !== null,
    refetchInterval: 15_000
  });
  const inboxUnreadCount = inboxBadgeQuery.data ?? 0;

  const connectedOnlyHrefs = new Set(["/seller", "/settings", "/inbox"]);
  const visibleNavItems = isConnected ? navItems : navItems.filter((item) => !connectedOnlyHrefs.has(item.href));

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/" className="text-lg font-semibold text-slate-950">
              ChainUs
            </Link>
            <p className="text-sm text-slate-500">Arbitrum escrow marketplace</p>
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
                {item.href === "/inbox" ? <NewOrderBadge count={inboxUnreadCount} /> : null}
              </Link>
            ))}
            {siwe.sessionAddress ? (
              <button
                type="button"
                onClick={() => void siwe.signOut()}
                className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                SIWE Logout
              </button>
            ) : null}
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
