import type { DiscoverPolicyView } from "@/types/discover";

export function DiscoverPolicySection({ policy }: { policy: DiscoverPolicyView }) {
  const keywords =
    policy.search_keywords.length > 0
      ? policy.search_keywords.join(" · ")
      : "키워드 없음";

  return (
    <section className="rounded-xl border border-border/70 bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Discover Policy
          </p>
          <h2 className="mt-1 text-base font-semibold tracking-tight">
            Agent 발굴 기준
          </h2>
        </div>
        <span
          className={
            policy.active
              ? "rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-foreground"
              : "rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground"
          }
        >
          {policy.active ? "활성" : "비활성"}
        </span>
      </div>

      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-[11px] font-medium text-muted-foreground">
            현재 키워드
          </dt>
          <dd className="mt-1 text-foreground/90">{keywords}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium text-muted-foreground">목표</dt>
          <dd className="mt-1 text-foreground/90">
            {policy.goal_label ?? "목표 미설정"}
            {policy.target_categories.length > 0
              ? ` · ${policy.target_categories.join(", ")}`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium text-muted-foreground">
            Tick당 후보 상한
          </dt>
          <dd className="mt-1 tabular-nums text-foreground/90">
            {policy.max_candidates_per_tick}
          </dd>
        </div>
        {policy.exclude_keywords.length > 0 ? (
          <div>
            <dt className="text-[11px] font-medium text-muted-foreground">
              제외 키워드 (학습 반영)
            </dt>
            <dd className="mt-1 text-foreground/80">
              {policy.exclude_keywords.join(" · ")}
            </dd>
          </div>
        ) : null}
      </dl>

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Agent Tick이 후보를 가져옵니다. 여기서는 검토만 합니다.
      </p>
    </section>
  );
}
