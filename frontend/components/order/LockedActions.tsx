"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import type { LockedAction } from "@/lib/orderPermissions";

export function LockedActions({ locked }: { locked: LockedAction[] }) {
  const [open, setOpen] = useState(false);

  if (locked.length === 0) {
    return null;
  }

  return (
    <Card>
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-center justify-between text-left">
        <span className="font-semibold text-slate-950">暂时不可用的操作（{locked.length}）</span>
        <span className="text-sm text-slate-500">{open ? "收起" : "展开"}</span>
      </button>
      {open ? (
        <div className="mt-4 space-y-3">
          {locked.map((action) => (
            <div key={`${action.action}:${action.reason}`} className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="font-medium text-slate-700">🔒 {action.label}</p>
              <p className="mt-1 text-sm text-slate-500">{action.reason}</p>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
