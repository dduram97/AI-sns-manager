"use client";

import {
  Ban,
  CheckCircle2,
  CircleDot,
  Clock3,
  Eye,
  FileCheck2,
  GitBranch,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { DecisionExplainCard } from "@/components/decision/DecisionExplainCard";
import type { DecisionExplainView } from "@/lib/decisionExplain";
import { cn } from "@/lib/utils";
import type { ActivityKind } from "@/workers/types";

export interface TimelineActivity {
  id: string;
  kind: ActivityKind;
  summary: string;
  created_at: string;
  workflowStage: string | null;
  decision_id?: string | null;
  decisionExplain?: DecisionExplainView | null;
}

const KIND_META: Record<
  ActivityKind,
  { label: string; Icon: LucideIcon }
> = {
  executed: { label: "executed", Icon: CheckCircle2 },
  observed: { label: "observed", Icon: Eye },
  approval_created: { label: "approval_created", Icon: FileCheck2 },
  approved: { label: "approved", Icon: ShieldCheck },
  rejected: { label: "rejected", Icon: XCircle },
  blocked: { label: "blocked", Icon: Ban },
  waiting: { label: "waiting", Icon: Clock3 },
  stage_changed: { label: "stage_changed", Icon: GitBranch },
  completed: { label: "completed", Icon: CircleDot },
};

const INLINE_EXPLAIN_KINDS = new Set<ActivityKind>([
  "stage_changed",
  "approval_created",
  "blocked",
  "waiting",
]);

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ActivityTimeline({ items }: { items: TimelineActivity[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">이력 없음</p>;
  }

  const ordered = [...items].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const selected = ordered.find((a) => a.id === selectedId);

  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {ordered.map((a) => {
          const meta = KIND_META[a.kind] ?? {
            label: a.kind,
            Icon: CircleDot,
          };
          const Icon = meta.Icon;
          const hasDecision = Boolean(a.decisionExplain);
          const isSelected = selectedId === a.id;
          const showInline =
            INLINE_EXPLAIN_KINDS.has(a.kind) && a.decisionExplain;

          return (
            <li key={a.id}>
              <button
                type="button"
                disabled={!hasDecision}
                onClick={() =>
                  setSelectedId((cur) => (cur === a.id ? null : a.id))
                }
                className={cn(
                  "flex w-full gap-3 rounded-lg border border-border/50 bg-secondary/30 px-3 py-2.5 text-left transition-colors",
                  hasDecision && "hover:bg-secondary/50",
                  isSelected && "border-foreground/30 bg-secondary/60",
                  !hasDecision && "cursor-default",
                )}
              >
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background text-foreground/80">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {meta.label}
                      {hasDecision ? " · Decision" : ""}
                    </p>
                    <time className="text-[11px] tabular-nums text-muted-foreground">
                      {formatTime(a.created_at)}
                    </time>
                  </div>
                  {a.workflowStage ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Workflow · {a.workflowStage}
                    </p>
                  ) : null}
                  <p className="mt-1 text-sm leading-snug">{a.summary}</p>
                  {showInline && a.decisionExplain ? (
                    <DecisionExplainCard
                      data={a.decisionExplain}
                      mode="inline"
                    />
                  ) : null}
                </div>
              </button>
            </li>
          );
        })}
      </ol>

      {selected?.decisionExplain && !INLINE_EXPLAIN_KINDS.has(selected.kind) ? (
        <DecisionExplainCard
          data={selected.decisionExplain}
          mode="full"
          title="왜 Agent가 이 결정을 했나요?"
        />
      ) : null}

      {selected?.decisionExplain && INLINE_EXPLAIN_KINDS.has(selected.kind) ? (
        <DecisionExplainCard
          data={selected.decisionExplain}
          mode="full"
          title="왜 Agent가 이 결정을 했나요?"
        />
      ) : null}
    </div>
  );
}
