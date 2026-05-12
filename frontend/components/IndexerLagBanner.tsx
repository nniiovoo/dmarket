"use client";

import { useIndexerLag } from "@/lib/useIndexerLag";

export function IndexerLagBanner() {
  const { isLagging, isLoading, lagBlocks } = useIndexerLag();

  if (isLoading || !isLagging) {
    return null;
  }

  return (
    <div className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
      后端数据同步暂时滞后 {lagBlocks} 个区块。你的订单仍在链上安全保存，但 UI 显示可能延迟。
    </div>
  );
}
