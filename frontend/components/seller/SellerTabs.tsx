"use client";

export type SellerTab = "pending" | "products" | "orders";

const tabs: Array<{ id: SellerTab; label: string }> = [
  { id: "pending", label: "待发货" },
  { id: "products", label: "我的商品" },
  { id: "orders", label: "全部订单" }
];

export function SellerTabs({
  activeTab,
  pendingCount,
  onChange
}: {
  activeTab: SellerTab;
  pendingCount: number;
  onChange: (tab: SellerTab) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-slate-200">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`border-b-2 px-3 py-3 text-sm font-medium ${
            activeTab === tab.id
              ? "border-slate-900 text-slate-950"
              : "border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-900"
          }`}
        >
          {tab.label}
          {tab.id === "pending" && pendingCount > 0 ? (
            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">{pendingCount}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
