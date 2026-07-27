"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatExplainReason,
  type DecisionExplainView,
} from "@/lib/decisionExplain";
import { cn } from "@/lib/utils";

export type DecisionExplainMode = "approval" | "full" | "inline";

export function DecisionExplainCard({
  data,
  mode = "full",
  title,
  className,
}: {
  data: DecisionExplainView;
  mode?: DecisionExplainMode;
  title?: string;
  className?: string;
}) {
  const [rulesOpen, setRulesOpen] = useState(false);

  if (mode === "approval") {
    return (
      <div
        className={cn(
          "mt-4 rounded-lg border border-border/60 bg-secondary/40 px-3 py-3",
          className,
        )}
      >
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title ?? "왜 추천했나요?"}
        </p>
        {data.explanation ? (
          <p className="mt-2 text-sm leading-relaxed text-foreground/90">
            {data.explanation}
          </p>
        ) : null}
        <ul className="mt-2 space-y-1.5">
          {data.reasons.map((r, i) => (
            <li
              key={`${data.decisionId}-r-${i}`}
              className="flex gap-2 text-sm text-foreground/80"
            >
              <span className="shrink-0 text-muted-foreground">•</span>
              <span>{formatExplainReason(r)}</span>
            </li>
          ))}
        </ul>
        {data.rule_ids.length > 0 ? (
          <button
            type="button"
            className="mt-2 text-[10px] text-muted-foreground/70 underline-offset-2 hover:underline"
            title={data.rule_ids.join(", ")}
            onClick={() => {
              console.debug("[DecisionExplain] rule_ids", data.rule_ids);
            }}
          >
            rule refs (dev)
          </button>
        ) : null}
      </div>
    );
  }

  if (mode === "inline") {
    return (
      <div className={cn("mt-2 space-y-1.5", className)}>
        <p className="text-sm font-medium leading-snug">{data.reason_short}</p>
        {data.explanation && data.explanation !== data.reason_short ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {data.explanation}
          </p>
        ) : null}
        <ul className="space-y-1">
          {data.reasons.slice(0, 6).map((r, i) => (
            <li
              key={`${data.decisionId}-i-${i}`}
              className="flex gap-1.5 text-xs text-muted-foreground"
            >
              <span>•</span>
              <span>{formatExplainReason(r)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <Card className={cn("border-border/70 shadow-none", className)}>
      <CardHeader>
        <CardTitle>{title ?? "Decision Explain"}</CardTitle>
        <p className="text-base font-semibold tracking-tight text-foreground">
          {data.reason_short}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed text-foreground/85">
          {data.explanation}
        </p>
        <ul className="space-y-1.5 border-t border-border/50 pt-3">
          {data.reasons.map((r, i) => (
            <li
              key={`${data.decisionId}-f-${i}`}
              className="flex gap-2 text-sm text-foreground/80"
            >
              <span className="shrink-0 text-muted-foreground">•</span>
              <span>{formatExplainReason(r)}</span>
            </li>
          ))}
        </ul>
        {data.rule_ids.length > 0 ? (
          <div className="border-t border-border/50 pt-2">
            <button
              type="button"
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setRulesOpen((v) => !v)}
            >
              {rulesOpen ? "rule_ids 접기" : "rule_ids 펼치기"}
            </button>
            {rulesOpen ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {data.rule_ids.map((id) => (
                  <li
                    key={id}
                    className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {id}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
