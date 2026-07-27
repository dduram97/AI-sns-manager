export function DashboardScoreBadge({
  label,
  score,
}: {
  label: string;
  score: number;
}) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-primary">
      {label} {score.toLocaleString("ko-KR")}
    </span>
  );
}
