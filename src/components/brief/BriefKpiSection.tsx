function Kpi({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="rounded-lg bg-secondary/60 px-3 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums tracking-tight">
          {value}
        </span>
        {unit ? (
          <span className="text-xs text-muted-foreground">{unit}</span>
        ) : null}
      </p>
    </div>
  );
}

export function BriefKpiSection({
  interventionMinutes,
  timeSavedMinutes,
  approvalCount,
}: {
  interventionMinutes: number;
  timeSavedMinutes: number;
  approvalCount: number;
}) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Brief KPI
      </h2>
      <div className="grid grid-cols-3 gap-2">
        <Kpi
          label="예상 개입"
          value={interventionMinutes.toFixed(1)}
          unit="분"
        />
        <Kpi
          label="절약"
          value={timeSavedMinutes.toFixed(1)}
          unit="분"
        />
        <Kpi label="Approval" value={String(approvalCount)} unit="건" />
      </div>
    </section>
  );
}
