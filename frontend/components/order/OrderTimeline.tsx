import { formatTimestamp } from "@/lib/order";
import type { TimelineStage } from "@/lib/orderTimeline";

export function OrderTimeline({ stages, connectedAddress }: { stages: TimelineStage[]; connectedAddress?: string }) {
  return (
    <div className="space-y-5">
      {stages.map((stage, index) => (
        <div key={`${stage.key}:${index}`} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
          <div className="flex flex-col items-center">
            <StageDot state={stage.state} />
            {index < stages.length - 1 ? <div className="mt-1 min-h-10 w-px flex-1 bg-slate-200" /> : null}
          </div>
          <div className="pb-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className={stage.state === "current" ? "font-semibold text-blue-900" : "font-semibold text-slate-950"}>{stage.label}</p>
              {stage.state === "current" ? <span className="text-xs font-medium text-blue-700">当前阶段</span> : null}
            </div>
            <p className="mt-1 text-sm text-slate-600">{stage.note}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
              {stage.at !== undefined && stage.at > 0n ? <span>{formatTimestamp(stage.at)}</span> : null}
              {stage.actor ? (
                <span>
                  by {shortAddress(stage.actor)}
                  {sameAddress(stage.actor, connectedAddress) ? "（你）" : ""}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StageDot({ state }: { state: TimelineStage["state"] }) {
  if (state === "done") {
    return <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">✓</div>;
  }
  if (state === "current") {
    return <div className="h-6 w-6 rounded-full border-4 border-blue-200 bg-blue-600 animate-pulse" />;
  }
  if (state === "terminal") {
    return <div className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-800">!</div>;
  }
  return <div className="h-6 w-6 rounded-full border border-slate-300 bg-white" />;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function sameAddress(a: string | undefined, b: string | undefined) {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}
