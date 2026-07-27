import { DiscoverCandidateCard } from "@/components/discover/DiscoverCandidateCard";
import { DiscoverPolicySection } from "@/components/discover/DiscoverPolicySection";
import type { DiscoverScreenData } from "@/types/discover";

export function DiscoverScreen({ data }: { data: DiscoverScreenData }) {
  const { policy, candidates } = data;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5 px-4 pb-28 pt-6">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Supervisor
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">발굴</h1>
        <p className="text-sm text-muted-foreground">
          Agent가 발견한 후보를 검토합니다. {candidates.length}건 대기
        </p>
      </header>

      <DiscoverPolicySection policy={policy} />

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            Agent Candidate List
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            검색·수동 발굴 없음 · 관심 여부만 결정
          </p>
        </div>

        {candidates.length === 0 ? (
          <div className="rounded-xl border border-border/70 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            검토할 후보가 없습니다.
            {!policy.active
              ? " Discover Policy가 비활성입니다."
              : policy.search_keywords.length === 0
                ? " 키워드를 Policy에 설정하면 Agent가 후보를 가져옵니다."
                : " 다음 Agent Tick을 기다리세요."}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {candidates.map((c) => (
              <DiscoverCandidateCard key={c.personId} item={c} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
