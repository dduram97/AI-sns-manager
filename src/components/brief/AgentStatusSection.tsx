import { cn } from "@/lib/utils";
import type { AgentUiStatus } from "@/services/getAgentBrief";

const styles: Record<
  AgentUiStatus,
  { dot: string; chip: string }
> = {
  active: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/10 text-emerald-700",
  },
  syncing: {
    dot: "bg-amber-500 animate-pulse",
    chip: "bg-amber-500/10 text-amber-800",
  },
  warning: {
    dot: "bg-rose-500",
    chip: "bg-rose-500/10 text-rose-700",
  },
};

export function AgentStatusSection({
  status,
  statusLabel,
  lastTickLabel,
  syncSummary,
}: {
  status: AgentUiStatus;
  statusLabel: string;
  lastTickLabel: string;
  syncSummary: string;
}) {
  const s = styles[status];
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Agent Status
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className={cn("h-2.5 w-2.5 rounded-full", s.dot)} />
            <span className="text-lg font-semibold tracking-tight">{statusLabel}</span>
          </div>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", s.chip)}>
          {status}
        </span>
      </div>
      <dl className="mt-4 grid gap-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">마지막 Tick</dt>
          <dd className="font-medium tabular-nums">{lastTickLabel}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">동기화</dt>
          <dd className="max-w-[60%] text-right text-xs leading-snug text-foreground/80">
            {syncSummary}
          </dd>
        </div>
      </dl>
    </section>
  );
}
