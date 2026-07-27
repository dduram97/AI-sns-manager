import type { TodayWeeklyStats } from "@/types/todayDashboard";

function StatItem({
  label,
  value,
  unit,
}: {
  label: string;
  value: number;
  unit: string;
}) {
  return (
    <div className="rounded-lg bg-secondary/60 px-3 py-3">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
        {value.toLocaleString("ko-KR")}
        <span className="ml-1 text-sm font-normal text-muted-foreground">
          {unit}
        </span>
      </p>
    </div>
  );
}

export function TodayWeeklyStatsCard({ stats }: { stats: TodayWeeklyStats }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <div className="grid grid-cols-2 gap-2">
        <StatItem label="이번주 방문자" value={stats.visitors} unit="명" />
        <StatItem label="이번주 공감" value={stats.likes} unit="개" />
        <StatItem label="이번주 댓글" value={stats.comments} unit="개" />
        <StatItem label="이번주 새 이웃" value={stats.newNeighbors} unit="명" />
      </div>
    </section>
  );
}
