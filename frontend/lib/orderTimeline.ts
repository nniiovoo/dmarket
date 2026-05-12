import { OrderStatus, type OrderView } from "@/lib/order";

export type TimelineStage = {
  key: "created" | "paid" | "shipped" | "completed" | "cancelled" | "disputed" | "refunded";
  label: string;
  state: "done" | "current" | "upcoming" | "terminal";
  actor?: string;
  at?: bigint;
  note: string;
};

export function computeTimeline(order: OrderView): TimelineStage[] {
  const stages: TimelineStage[] = [
    {
      key: "created",
      label: "已下单",
      state: "done",
      actor: order.buyer,
      at: order.createdAt,
      note: `买家 ${shortAddress(order.buyer)} 创建了订单。`
    },
    {
      key: "paid",
      label: paidLabel(order.status),
      state: paidState(order.status),
      actor: order.buyer,
      at: order.paidAt,
      note: paidNote(order.status)
    },
    {
      key: "shipped",
      label: shippedLabel(order.status),
      state: shippedState(order.status),
      actor: order.seller,
      at: order.shippedAt,
      note: shippedNote(order.status, order.seller)
    },
    {
      key: "completed",
      label: completedLabel(order.status),
      state: completedState(order.status),
      actor: order.buyer,
      at: order.completedAt,
      note: completedNote(order.status)
    }
  ];

  if (order.status === OrderStatus.Cancelled) {
    return [...stages.slice(0, 1), terminalStage("cancelled", "订单已取消", "订单在付款前终止。")];
  }

  if (order.status === OrderStatus.Disputed) {
    const insertAfter = order.shippedAt > 0n ? 3 : 2;
    return [
      ...stages.slice(0, insertAfter),
      terminalStage("disputed", "争议中", "订单已进入平台仲裁流程。"),
      ...stages.slice(insertAfter).map((stage) => ({ ...stage, state: "upcoming" as const }))
    ];
  }

  if (order.status === OrderStatus.Refunded) {
    const insertAfter = order.shippedAt > 0n ? 3 : 2;
    return [
      ...stages.slice(0, insertAfter),
      terminalStage("refunded", "已退款", "托管资金已退回买家。"),
      ...stages.slice(insertAfter).map((stage) => ({ ...stage, state: "upcoming" as const }))
    ];
  }

  return stages;
}

function paidState(status: OrderStatus) {
  if ([OrderStatus.Paid, OrderStatus.Shipped, OrderStatus.Completed, OrderStatus.Disputed, OrderStatus.Refunded].includes(status)) {
    return "done" as const;
  }
  return status === OrderStatus.Created ? "current" : "upcoming";
}

function shippedState(status: OrderStatus) {
  if ([OrderStatus.Shipped, OrderStatus.Completed].includes(status)) {
    return "done" as const;
  }
  return status === OrderStatus.Paid ? "current" : "upcoming";
}

function completedState(status: OrderStatus) {
  if (status === OrderStatus.Completed) {
    return "done" as const;
  }
  return status === OrderStatus.Shipped ? "current" : "upcoming";
}

function paidLabel(status: OrderStatus) {
  return status === OrderStatus.Created ? "等待买家付款" : "已付款";
}

function shippedLabel(status: OrderStatus) {
  return status === OrderStatus.Paid ? "等待卖家发货" : "已发货";
}

function completedLabel(status: OrderStatus) {
  return status === OrderStatus.Shipped ? "等待买家确认收货" : "已完成";
}

function paidNote(status: OrderStatus) {
  return status === OrderStatus.Created ? "买家付款后，资金会锁入托管。" : "订单金额已锁入托管。";
}

function shippedNote(status: OrderStatus, seller: string) {
  return status === OrderStatus.Paid ? `卖家 ${shortAddress(seller)} 还没标记发货。` : "卖家已标记发货。";
}

function completedNote(status: OrderStatus) {
  return status === OrderStatus.Shipped ? "买家确认收货后，资金会释放给卖家。" : "资金已完成结算。";
}

function terminalStage(key: "cancelled" | "disputed" | "refunded", label: string, note: string): TimelineStage {
  return {
    key,
    label,
    state: "terminal",
    note
  };
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
