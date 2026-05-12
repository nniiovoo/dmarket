"use client";

import { useCallback, useEffect, useState } from "react";

import type { OrderStatusName, ProductSummary } from "@/lib/orders";

const STORAGE_KEY = "chainus-pending-orders";
const TTL_MS = 24 * 60 * 60 * 1_000;

export type PendingOrder = {
  chainId: number;
  onChainOrderId: string;
  buyer: string;
  seller: string;
  productId: string;
  amountWei: string;
  status: OrderStatusName;
  product: ProductSummary | null;
  createdAt: number;
};

export function useOptimisticOrder() {
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const valid = readPendingOrders();
      setPendingOrders(valid);
      writePendingOrders(valid);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, []);

  const addPending = useCallback((order: Omit<PendingOrder, "createdAt" | "status"> & { status?: OrderStatusName }) => {
    setPendingOrders((current) => {
      const nextOrder = { ...order, status: order.status ?? "Paid", createdAt: Date.now() };
      const filtered = current.filter(
        (item) => !(item.chainId === nextOrder.chainId && item.onChainOrderId === nextOrder.onChainOrderId)
      );
      const updated = [nextOrder, ...filtered].filter(isFresh);
      writePendingOrders(updated);
      return updated;
    });
  }, []);

  const clearPending = useCallback((chainId: number, onChainOrderId: string) => {
    setPendingOrders((current) => {
      const updated = current.filter((item) => !(item.chainId === chainId && item.onChainOrderId === onChainOrderId));
      writePendingOrders(updated);
      return updated;
    });
  }, []);

  return { pendingOrders, addPending, clearPending };
}

function readPendingOrders() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as PendingOrder[]) : [];
    return parsed.filter(isFresh);
  } catch {
    return [];
  }
}

function writePendingOrders(orders: PendingOrder[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
}

function isFresh(order: PendingOrder) {
  return Date.now() - order.createdAt < TTL_MS;
}
