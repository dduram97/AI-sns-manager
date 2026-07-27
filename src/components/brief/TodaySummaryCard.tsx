"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { TodaySummaryViewModel } from "@/types/todaySummary";

function scrollToApprovalSection() {
  const headings = document.querySelectorAll("h2");
  for (const heading of headings) {
    if (heading.textContent?.trim() === "Approval Inbox") {
      heading.closest("section")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      return;
    }
  }
}

function TaskProgress({
  completed,
  total,
}: {
  completed: number;
  total: number;
}) {
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <p className="text-[11px] font-medium text-muted-foreground">진행률</p>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${completed} / ${total}`}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {completed} / {total}
        </span>
        <span className="tabular-nums font-medium">{percent}%</span>
      </div>
    </div>
  );
}

type TodayTask = {
  id: string;
  title: string;
  pending: number;
  completed: number;
  total: number;
  unit: string;
  completedLabel: string;
  actionLabel: string;
  href?: string;
  onAction?: () => void;
};

function neighborRequestHref(data: TodaySummaryViewModel): string {
  if (data.neighborRequest.candidates > 0) {
    return "/neighbors?tab=candidates";
  }
  if (data.neighborRequest.completed > 0) {
    return "/neighbors?tab=completed";
  }
  return "/neighbors?tab=candidates";
}

function buildTodayTasks(data: TodaySummaryViewModel): TodayTask[] {
  const tasks: TodayTask[] = [
    {
      id: "comment",
      title: "📝 댓글 승인",
      pending: data.comment.pending,
      completed: data.comment.completed,
      total: data.comment.pending + data.comment.completed,
      unit: "건",
      completedLabel: "오늘 완료",
      actionLabel: "처리하기",
      onAction: scrollToApprovalSection,
    },
    {
      id: "neighbor-request",
      title: "🤝 서로이웃 후보",
      pending: data.neighborRequest.candidates,
      completed: data.neighborRequest.completed,
      total: data.neighborRequest.candidates + data.neighborRequest.completed,
      unit: "명",
      completedLabel: "신청 완료",
      actionLabel: "후보 보기",
      href: neighborRequestHref(data),
    },
    {
      id: "neighbor-feed",
      title: "📢 새글 반응",
      pending: data.neighborFeed.pending,
      completed: data.neighborFeed.completed,
      total: data.neighborFeed.pending + data.neighborFeed.completed,
      unit: "건",
      completedLabel: "오늘 완료",
      actionLabel: "처리하기",
      href: "/neighbors?tab=feed",
    },
  ];

  return [...tasks].sort((a, b) => b.pending - a.pending);
}

function TaskActionButton({ task }: { task: TodayTask }) {
  if (task.href) {
    return (
      <Button asChild size="sm" variant="secondary" className="h-8 px-3 text-xs">
        <Link href={task.href}>{task.actionLabel}</Link>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className="h-8 px-3 text-xs"
      onClick={task.onAction}
    >
      {task.actionLabel}
    </Button>
  );
}

function TodayTaskCard({ task }: { task: TodayTask }) {
  return (
    <article className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-tight">{task.title}</h3>
          <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">
            {task.pending.toLocaleString("ko-KR")}
            <span className="ml-1 text-base font-medium text-muted-foreground">
              {task.unit}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {task.completedLabel}{" "}
            <span className="tabular-nums text-foreground/70">
              {task.completed.toLocaleString("ko-KR")}
              {task.unit}
            </span>
          </p>
        </div>
      </div>

      <TaskProgress completed={task.completed} total={task.total} />

      <div className="mt-3 flex justify-end">
        <TaskActionButton task={task} />
      </div>
    </article>
  );
}

export function TodaySummaryCard({ data }: { data: TodaySummaryViewModel }) {
  const tasks = buildTodayTasks(data);

  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <h2 className="text-base font-semibold tracking-tight">
        🔥 오늘 해야 할 일
      </h2>

      <div className="mt-4 space-y-3">
        {tasks.map((task) => (
          <TodayTaskCard key={task.id} task={task} />
        ))}
      </div>
    </section>
  );
}
