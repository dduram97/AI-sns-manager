function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 py-2.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export function ActivitySummarySection({
  autoVisits,
  autoLikes,
  approvalsDone,
  observe,
  waiting,
}: {
  autoVisits: number;
  autoLikes: number;
  approvalsDone: number;
  observe: number;
  waiting: number;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Activity Summary
      </h2>
      <div className="mt-1">
        <Row label="자동 방문" value={autoVisits} />
        <Row label="자동 공감" value={autoLikes} />
        <Row label="승인 완료" value={approvalsDone} />
        <Row label="관찰" value={observe} />
        <Row label="대기" value={waiting} />
      </div>
    </section>
  );
}
