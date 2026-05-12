import { OrderStatus } from "@/lib/order";

const labels: Record<OrderStatus, string> = {
  [OrderStatus.Created]: "已创建",
  [OrderStatus.Paid]: "已付款",
  [OrderStatus.Shipped]: "已发货",
  [OrderStatus.Completed]: "已完成",
  [OrderStatus.Cancelled]: "已取消",
  [OrderStatus.Disputed]: "争议中",
  [OrderStatus.Refunded]: "已退款"
};

const styles: Record<OrderStatus, string> = {
  [OrderStatus.Created]: "bg-slate-100 text-slate-700",
  [OrderStatus.Paid]: "bg-blue-100 text-blue-700",
  [OrderStatus.Shipped]: "bg-indigo-100 text-indigo-700",
  [OrderStatus.Completed]: "bg-emerald-100 text-emerald-700",
  [OrderStatus.Cancelled]: "bg-slate-200 text-slate-700",
  [OrderStatus.Disputed]: "bg-amber-100 text-amber-800",
  [OrderStatus.Refunded]: "bg-teal-100 text-teal-700"
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${styles[status]}`}>{labels[status]}</span>;
}
