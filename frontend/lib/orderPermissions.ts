import { OrderStatus } from "@/lib/order";

export type Role = "buyer" | "seller" | "owner" | "stranger";

export type ActionKind =
  | "pay"
  | "cancel"
  | "confirmReceived"
  | "openDispute"
  | "markShipped"
  | "resolveDispute"
  | "emergencyRefund";

export type AvailableAction = {
  kind: "available";
  label: string;
  description: string;
  buttonLabel: string;
  action: ActionKind;
  variant: "primary" | "danger" | "neutral";
};

export type LockedAction = {
  kind: "locked";
  label: string;
  reason: string;
  action: ActionKind;
};

export function getRole(args: {
  connectedAddress?: string;
  orderBuyer: string;
  orderSeller: string;
  contractOwner?: string;
}): Role {
  const me = args.connectedAddress?.toLowerCase();

  if (!me) {
    return "stranger";
  }
  if (me === args.orderBuyer.toLowerCase()) {
    return "buyer";
  }
  if (me === args.orderSeller.toLowerCase()) {
    return "seller";
  }
  if (args.contractOwner !== undefined && me === args.contractOwner.toLowerCase()) {
    return "owner";
  }

  return "stranger";
}

export function computeActions(args: { role: Role; status: OrderStatus; amountLabel: string }) {
  const available: AvailableAction[] = [];
  const locked: LockedAction[] = [];
  const { role, status, amountLabel } = args;

  if (role === "buyer") {
    if (status === OrderStatus.Created) {
      available.push(action("pay"), action("cancel"));
      locked.push(lockedAction("confirmReceived", "等卖家标记发货后，你才能确认收货。"));
      locked.push(lockedAction("openDispute", "付款后或发货后才能发起争议。"));
    } else if (status === OrderStatus.Paid) {
      available.push(action("openDispute"));
      locked.push(lockedAction("cancel", "订单已付款，不能再取消。"));
      locked.push(lockedAction("confirmReceived", "等卖家标记发货后，你才能确认收货。"));
    } else if (status === OrderStatus.Shipped) {
      available.push(action("confirmReceived"), action("openDispute"));
      locked.push(lockedAction("cancel", "订单已发货，不能取消。"));
    } else if (status === OrderStatus.Completed) {
      locked.push(lockedAction("confirmReceived", "订单已完成，资金已结算给卖家。"));
    } else if (status === OrderStatus.Cancelled) {
      locked.push(lockedAction("pay", "订单已取消，不能付款。"));
    } else if (status === OrderStatus.Disputed) {
      locked.push(lockedAction("openDispute", "争议已发起，正在等待平台仲裁。"));
    } else if (status === OrderStatus.Refunded) {
      locked.push(lockedAction("pay", `订单已退款，${amountLabel} 已退回买家。`));
    }
  }

  if (role === "seller") {
    if (status === OrderStatus.Created) {
      locked.push(lockedAction("markShipped", "等买家付款后，你才能标记发货。"));
    } else if (status === OrderStatus.Paid) {
      available.push(action("markShipped"), action("openDispute"));
    } else if (status === OrderStatus.Shipped) {
      available.push(action("openDispute"));
      locked.push(lockedAction("markShipped", "你已经标记过发货。"));
    } else if (status === OrderStatus.Completed) {
      locked.push(lockedAction("markShipped", `订单已完成，${amountLabel} 已结算给卖家。`));
    }
  }

  if (role === "owner") {
    if (status === OrderStatus.Disputed) {
      available.push(action("resolveDispute"), action("emergencyRefund"));
    } else if (status === OrderStatus.Paid || status === OrderStatus.Shipped) {
      available.push(action("emergencyRefund"));
      locked.push(lockedAction("resolveDispute", "只有争议中的订单才能仲裁。"));
    } else {
      locked.push(lockedAction("emergencyRefund", "只有已付款、已发货或争议中的订单才能紧急退款。"));
      locked.push(lockedAction("resolveDispute", "只有争议中的订单才能仲裁。"));
    }
  }

  return { available, locked };
}

function action(kind: ActionKind): AvailableAction {
  const copy: Record<ActionKind, Omit<AvailableAction, "kind" | "action">> = {
    pay: {
      label: "支付订单",
      description: "把订单金额锁入托管合约。付款后卖家才能发货。",
      buttonLabel: "立即付款",
      variant: "primary"
    },
    cancel: {
      label: "取消订单",
      description: "订单还没付款，可以取消。取消后这笔订单不会继续推进。",
      buttonLabel: "取消订单",
      variant: "neutral"
    },
    confirmReceived: {
      label: "确认收货",
      description: "确认你已经收到商品，托管资金会释放给卖家。",
      buttonLabel: "确认收货",
      variant: "primary"
    },
    openDispute: {
      label: "发起争议",
      description: "如果商品有问题或对方迟迟不推进，可以发起争议让平台介入。",
      buttonLabel: "发起争议",
      variant: "danger"
    },
    markShipped: {
      label: "标记发货",
      description: "买家已付款。填写物流信息并在链上标记订单已发货。",
      buttonLabel: "标记发货",
      variant: "primary"
    },
    resolveDispute: {
      label: "仲裁争议",
      description: "选择退款给买家，或把托管资金释放给卖家。",
      buttonLabel: "处理争议",
      variant: "primary"
    },
    emergencyRefund: {
      label: "紧急退款",
      description: "平台 owner 可在资金仍托管时直接退款给买家。",
      buttonLabel: "紧急退款",
      variant: "danger"
    }
  };

  return { kind: "available", action: kind, ...copy[kind] };
}

function lockedAction(actionKind: ActionKind, reason: string): LockedAction {
  return {
    kind: "locked",
    action: actionKind,
    label: action(actionKind).label,
    reason
  };
}
