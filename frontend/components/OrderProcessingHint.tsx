"use client";

import { useEffect, useState } from "react";

export function OrderProcessingHint() {
  const [secondsElapsed, setSecondsElapsed] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsElapsed((current) => current + 1);
    }, 1_000);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-4">
      <div className="flex items-center gap-3">
        <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
        <p className="text-sm text-blue-900">正在同步商品和订单索引信息... 已等 {secondsElapsed}s，通常约 15s。</p>
      </div>
      {secondsElapsed > 30 ? (
        <p className="mt-2 text-xs text-amber-700">同步比平时慢。订单数据仍在链上安全保存，可能是 indexer 暂时离线。</p>
      ) : null}
    </div>
  );
}
