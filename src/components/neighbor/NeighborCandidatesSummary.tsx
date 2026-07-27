"use client";

type NeighborCandidatesSummaryProps = {
  candidateCount: number;
  todayExecuted: number;
};

function TaskProgress({
  completed,
  total,
}: {
  completed: number;
  total: number;
}) {
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-muted-foreground">진행률</p>
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

export function NeighborCandidatesSummary({
  candidateCount,
  todayExecuted,
}: NeighborCandidatesSummaryProps) {
  const total = candidateCount + todayExecuted;

  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <h2 className="text-base font-semibold tracking-tight">
        오늘 처리할 서로이웃
      </h2>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-secondary/60 px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            추천 후보
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
            {candidateCount}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              명
            </span>
          </p>
        </div>
        <div className="rounded-lg bg-secondary/60 px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            오늘 신청 완료
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
            {todayExecuted}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              명
            </span>
          </p>
        </div>
      </div>

      <TaskProgress completed={todayExecuted} total={total} />
    </section>
  );
}
