"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  filterAndSortPersons,
  type PersonListItem,
  type PersonSort,
} from "@/lib/personListUtils";
import type { RelationshipStage } from "@/workers/types";
import { cn } from "@/lib/utils";

const STAGES: Array<RelationshipStage | "all"> = [
  "all",
  "discover",
  "warming",
  "waiting_new_post",
  "approval_pending",
  "early_relationship",
  "maintain",
  "vip",
  "risk",
];

function formatTouch(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
}

export function PersonListScreen({ items }: { items: PersonListItem[] }) {
  const [q, setQ] = useState("");
  const [stage, setStage] = useState<RelationshipStage | "all">("all");
  const [sort, setSort] = useState<PersonSort>("priority");

  const filtered = useMemo(
    () => filterAndSortPersons(items, { q, stage, sort }),
    [items, q, stage, sort],
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{filtered.length}명</p>

      <div className="space-y-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="이름 검색"
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex gap-2 overflow-x-auto pb-1">
          {STAGES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStage(s)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium",
                stage === s
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground",
              )}
            >
              {s === "all" ? "전체" : s}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {(
            [
              ["priority", "Agent Priority"],
              ["last_touch", "Last Touch"],
              ["temperature", "Temperature"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSort(value)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[11px] font-medium",
                sort === value
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {filtered.map((item) => (
          <li key={item.person.id}>
            <Link
              href={`/people/${item.person.id}`}
              className="block rounded-xl border border-border/70 bg-card p-4 transition-colors hover:bg-secondary/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold tracking-tight">
                    {item.person.display_name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.relationship.stage}
                    {item.workflow
                      ? ` · wf ${item.workflow.current_state}`
                      : " · workflow 없음"}
                  </p>
                </div>
                {item.approvalCount > 0 ? (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                    승인 {item.approvalCount}
                  </span>
                ) : null}
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-md bg-secondary/60 py-2">
                  <dt className="text-muted-foreground">Temp</dt>
                  <dd className="mt-0.5 font-semibold tabular-nums">
                    {item.relationship.temperature}
                  </dd>
                </div>
                <div className="rounded-md bg-secondary/60 py-2">
                  <dt className="text-muted-foreground">Score</dt>
                  <dd className="mt-0.5 font-semibold tabular-nums">
                    {item.relationship.score}
                  </dd>
                </div>
                <div className="rounded-md bg-secondary/60 py-2">
                  <dt className="text-muted-foreground">Touch</dt>
                  <dd className="mt-0.5 font-semibold">
                    {formatTouch(item.relationship.last_touch_at)}
                  </dd>
                </div>
              </dl>
              {item.workflow ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Priority {item.workflow.priority}
                  {item.workflow.waiting_for
                    ? ` · wait: ${item.workflow.waiting_for}`
                    : ""}
                </p>
              ) : null}
            </Link>
          </li>
        ))}
        {filtered.length === 0 ? (
          <li className="rounded-xl border border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
            해당하는 사람이 없습니다.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
