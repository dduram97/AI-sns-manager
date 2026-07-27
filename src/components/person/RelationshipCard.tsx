import type { Person, RelationshipState, Workflow } from "@/workers/types";

function fmtTouch(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RelationshipCard({
  person,
  relationship,
  activeWorkflow,
  openApprovalCount,
}: {
  person: Person;
  relationship: RelationshipState;
  activeWorkflow: Workflow | null;
  openApprovalCount: number;
}) {
  const waitingReason =
    activeWorkflow?.waiting_for ??
    activeWorkflow?.blocked_reason ??
    (openApprovalCount > 0 ? "approval_pending" : null);

  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Relationship
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {person.display_name}
          </h1>
        </div>
        <span className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium">
          {relationship.stage}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-secondary/60 px-2 py-2.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Temp
          </dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">
            {relationship.temperature}
          </dd>
        </div>
        <div className="rounded-lg bg-secondary/60 px-2 py-2.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Score
          </dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">
            {relationship.score}
          </dd>
        </div>
        <div className="rounded-lg bg-secondary/60 px-2 py-2.5">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Touch
          </dt>
          <dd className="mt-0.5 text-xs font-semibold leading-tight">
            {fmtTouch(relationship.last_touch_at)}
          </dd>
        </div>
      </dl>

      <div className="mt-3 space-y-1.5 border-t border-border/50 pt-3 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Active Workflow</span>
          <span className="text-right font-medium">
            {activeWorkflow
              ? `${activeWorkflow.current_stage} · ${activeWorkflow.current_state}`
              : "없음"}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Waiting Reason</span>
          <span className="text-right font-medium">{waitingReason ?? "—"}</span>
        </div>
      </div>
    </section>
  );
}
