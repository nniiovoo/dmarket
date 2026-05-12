"use client";

import { useEffect, useState } from "react";

export function Toast({ message, onDone }: { message: string; onDone?: () => void }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(false);
      onDone?.();
    }, 3_000);

    return () => window.clearTimeout(timer);
  }, [onDone]);

  if (!visible) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-md border border-emerald-200 bg-white p-4 text-sm text-emerald-900 shadow-lg">
      {message}
    </div>
  );
}
