import type { ReactNode } from "react";

import { Card } from "@/components/Card";
import { ActionCard } from "@/components/order/ActionCard";
import type { AvailableAction, Role } from "@/lib/orderPermissions";

export function OrderActions({
  available,
  role,
  renderAction
}: {
  available: AvailableAction[];
  role: Role;
  renderAction: (action: AvailableAction) => ReactNode;
}) {
  return (
    <Card title="你现在可以做">
      {role === "stranger" ? (
        <p className="text-sm text-slate-600">你不是这单的买家/卖家，只能浏览订单进度。</p>
      ) : available.length === 0 ? (
        <p className="text-sm text-slate-600">{emptyCopy(role)}</p>
      ) : (
        <div className="space-y-3">
          {available.map((action) => (
            <ActionCard key={action.action} action={action}>
              {renderAction(action)}
            </ActionCard>
          ))}
        </div>
      )}
    </Card>
  );
}

function emptyCopy(role: Role) {
  if (role === "buyer") {
    return "你当前没有需要处理的买家动作。";
  }
  if (role === "seller") {
    return "你当前没有需要处理的卖家动作。";
  }
  if (role === "owner") {
    return "当前阶段没有平台 owner 需要处理的动作。";
  }
  return "你不是这单的参与方。";
}
