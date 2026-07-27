import Link from "next/link";
import { ActivityTimeline } from "@/components/person/ActivityTimeline";
import { PersonDecisionTimeline } from "@/components/person/PersonDecisionTimeline";
import { RelationshipCard } from "@/components/person/RelationshipCard";
import type { PersonDetailViewModel } from "@/types/personDetail";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/40 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function PersonDetailScreen({ data }: { data: PersonDetailViewModel }) {
  const { person, relationship, activeWorkflow } = data;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-28 pt-6">
      <Link
        href="/people"
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        ← 사람들
      </Link>

      <RelationshipCard
        person={person}
        relationship={relationship}
        activeWorkflow={activeWorkflow}
        openApprovalCount={data.openApprovalCount}
      />

      <Section title="Relationship State">
        <Row label="stage" value={relationship.stage} />
        <Row label="score" value={relationship.score} />
        <Row label="temperature" value={relationship.temperature} />
        <Row label="last visit" value={fmt(relationship.last_visit_at)} />
        <Row label="last like" value={fmt(relationship.last_like_at)} />
        <Row label="last comment" value={fmt(relationship.last_comment_at)} />
        <Row label="last touch" value={fmt(relationship.last_touch_at)} />
      </Section>

      <Section title="Active Workflow">
        {activeWorkflow ? (
          <>
            <Row label="id" value={activeWorkflow.id.slice(0, 8)} />
            <Row label="stage" value={activeWorkflow.current_stage} />
            <Row label="state" value={activeWorkflow.current_state} />
            <Row label="next action" value={activeWorkflow.next_action} />
            <Row label="priority" value={activeWorkflow.priority} />
            <Row
              label="waiting for"
              value={activeWorkflow.waiting_for ?? "—"}
            />
            <Row
              label="waiting until"
              value={fmt(activeWorkflow.waiting_until)}
            />
            <Row
              label="blocked"
              value={activeWorkflow.blocked_reason ?? "—"}
            />
            <Row label="goal" value={activeWorkflow.goal ?? "—"} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">활성 Workflow 없음</p>
        )}
      </Section>

      <Section title="Approval History">
        {data.approvals.length === 0 ? (
          <p className="text-sm text-muted-foreground">이력 없음</p>
        ) : (
          <ul className="space-y-2">
            {data.approvals.map((a) => (
              <li
                key={a.id}
                className="rounded-lg border border-border/50 px-3 py-2 text-sm"
              >
                <div className="flex justify-between gap-2">
                  <span className="font-medium">
                    {a.resolved_at ? "resolved" : "open"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {fmt(a.created_at)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  priority {a.inbox_priority}
                  {typeof a.presented_context?.reason_short === "string"
                    ? ` · ${a.presented_context.reason_short}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Decision Timeline">
        <PersonDecisionTimeline decisions={data.decisions} />
      </Section>

      <Section title="Activity Timeline">
        <ActivityTimeline items={data.timeline} />
      </Section>

      <Section title="Workflow History">
        {data.workflows.length === 0 && data.stageChanges.length === 0 ? (
          <p className="text-sm text-muted-foreground">이력 없음</p>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                workflows 레코드
              </p>
              <ul className="space-y-2">
                {data.workflows.map((w) => (
                  <li
                    key={w.id}
                    className="rounded-lg bg-secondary/50 px-3 py-2 text-xs"
                  >
                    <p className="font-medium">
                      {w.current_stage} / {w.current_state}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {w.id.slice(0, 8)} · updated {fmt(w.updated_at)}
                      {w.waiting_for ? ` · ${w.waiting_for}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
            {data.stageChanges.length > 0 ? (
              <div>
                <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                  stage_changed (activity)
                </p>
                <ul className="space-y-2">
                  {data.stageChanges.map((a) => (
                    <li key={a.id} className="text-sm">
                      <span className="text-xs text-muted-foreground">
                        {fmt(a.created_at)}
                      </span>
                      <p>{a.summary}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
