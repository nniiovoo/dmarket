import { orderStatusLabels, statusLabel } from "@/lib/order";

const styles = [
  "bg-slate-100 text-slate-700",
  "bg-blue-100 text-blue-700",
  "bg-indigo-100 text-indigo-700",
  "bg-emerald-100 text-emerald-700",
  "bg-slate-200 text-slate-700",
  "bg-amber-100 text-amber-800",
  "bg-teal-100 text-teal-700"
];

export function OrderBadge({ status }: { status: number | string | undefined }) {
  const statusIndex = typeof status === "string" ? orderStatusLabels.indexOf(status) : status;

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${styles[statusIndex ?? -1] ?? "bg-red-100 text-red-700"}`}>
      {typeof status === "string" ? status : statusLabel(status)}
    </span>
  );
}
