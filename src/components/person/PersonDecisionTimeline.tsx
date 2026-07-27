"use client";

import { useState } from "react";
import { DecisionExplainCard } from "@/components/decision/DecisionExplainCard";
import type { DecisionExplainView } from "@/lib/decisionExplain";
import { cn } from "@/lib/utils";

export function PersonDecisionTimeline({
  decisions,
}: {
  decisions: DecisionExplainView[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    decisions[0]?.decisionId ?? null,
  );

  if (decisions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Decision 이력 없음</p>
    );
  }

  const selected = decisions.find((d) => d.decisionId === selectedId) ?? null;

  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {decisions.map((d) => {
          const active = d.decisionId === selectedId;
          return (
            <li key={d.decisionId}>
              <button
                type="button"
                onClick={() => setSelectedId(d.decisionId)}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  active
                    ? "border-foreground/30 bg-secondary/70"
                    : "border-border/50 bg-secondary/30 hover:bg-secondary/50",
                )}
              >
                <p className="font-medium leading-snug">{d.reason_short}</p>
                <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                  {d.explanation}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
      {selected ? (
        <DecisionExplainCard
          data={selected}
          mode="full"
          title="왜 Agent가 이 결정을 했나요?"
        />
      ) : null}
    </div>
  );
}
