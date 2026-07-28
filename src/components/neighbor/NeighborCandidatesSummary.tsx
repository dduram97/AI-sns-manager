type NeighborCandidatesSummaryProps = {
  candidateCount: number;
  todayExecuted: number;
  todayFailed?: number;
  todayExcluded?: number;
  dailyLimit?: number;
  todayRemaining?: number;
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
      <p className="text-xs font-medium text-muted-foreground">진행률 (성공 기준)</p>
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
  todayFailed = 0,
  todayExcluded = 0,
  dailyLimit,
  todayRemaining,
}: NeighborCandidatesSummaryProps) {
  const limit = dailyLimit ?? todayExecuted + candidateCount;
  const remaining =
    todayRemaining ?? Math.max(0, limit - todayExecuted);

  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <h2 className="text-base font-semibold tracking-tight">
        오늘 처리할 서로이웃
      </h2>

      <div className="mt-3">
        <p className="text-[11px] font-medium text-muted-foreground">오늘 신청</p>
        <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight">
          {todayExecuted}
          <span className="text-base font-medium text-muted-foreground">
            {" "}
            / {limit}
          </span>
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg bg-secondary/60 px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">성공</p>
          <p className="mt-1 text-lg font-semibold tabular-nums tracking-tight">
            {todayExecuted}
            <span className="ml-0.5 text-xs font-normal text-muted-foreground">
              건
            </span>
          </p>
        </div>
        <div className="rounded-lg bg-secondary/60 px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">실패</p>
          <p className="mt-1 text-lg font-semibold tabular-nums tracking-tight">
            {todayFailed}
            <span className="ml-0.5 text-xs font-normal text-muted-foreground">
              건
            </span>
          </p>
        </div>
        <div className="rounded-lg bg-secondary/60 px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">제외</p>
          <p className="mt-1 text-lg font-semibold tabular-nums tracking-tight">
            {todayExcluded}
            <span className="ml-0.5 text-xs font-normal text-muted-foreground">
              건
            </span>
          </p>
        </div>
        <div className="rounded-lg bg-secondary/60 px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            남은 한도
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums tracking-tight">
            {remaining}
            <span className="ml-0.5 text-xs font-normal text-muted-foreground">
              건
            </span>
          </p>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        추천 후보 {candidateCount}명 · 실패/제외는 완료·한도에서 제외
      </p>

      <TaskProgress completed={todayExecuted} total={limit} />
    </section>
  );
}
