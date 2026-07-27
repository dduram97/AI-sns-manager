function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function RelationshipSummarySection({
  temperatureUp,
  mutualReactions,
  newRelationships,
  maintaining,
}: {
  temperatureUp: number;
  mutualReactions: number;
  newRelationships: number;
  maintaining: number;
}) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Relationship Summary
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="온도 상승" value={temperatureUp} />
        <Stat label="맞반응" value={mutualReactions} />
        <Stat label="신규 관계" value={newRelationships} />
        <Stat label="유지 중" value={maintaining} />
      </div>
    </section>
  );
}
