"use client";

import { useEffect, useState } from "react";

export function WalletPopupHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShow(true);
    }, 5_000);

    return () => window.clearTimeout(timer);
  }, []);

  if (!show) {
    return null;
  }

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">钱包没弹出来？</p>
      <p className="mt-1">点击浏览器右上角的 MetaMask 图标查看 pending 签名请求。有时弹窗会被其他窗口挡住。</p>
    </div>
  );
}
