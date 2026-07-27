import { AgentStatusSection } from "@/components/brief/AgentStatusSection";
import { BriefKpiSection } from "@/components/brief/BriefKpiSection";
import { ActivitySummarySection } from "@/components/brief/ActivitySummarySection";
import { ApprovalSummarySection } from "@/components/brief/ApprovalSummarySection";
import { RelationshipSummarySection } from "@/components/brief/RelationshipSummarySection";
import type { AgentBriefViewModel } from "@/services/getAgentBrief";

export function AgentBriefScreen({
  initialData,
}: {
  initialData: AgentBriefViewModel;
}) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-28 pt-6">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Supervisor Console
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Agent Brief</h1>
        <p className="text-sm text-muted-foreground">
          Agent가 처리한 일과 승인이 필요한 일만 확인합니다.
        </p>
      </header>

      <AgentStatusSection
        status={initialData.status}
        statusLabel={initialData.statusLabel}
        lastTickLabel={initialData.lastTickLabel}
        syncSummary={initialData.syncSummary}
      />

      <BriefKpiSection
        interventionMinutes={initialData.interventionMinutes}
        timeSavedMinutes={initialData.timeSavedMinutes}
        approvalCount={initialData.approvalCount}
      />

      <ActivitySummarySection {...initialData.activity} />

      <ApprovalSummarySection count={initialData.approvalCount} />

      <RelationshipSummarySection {...initialData.relationship} />
    </div>
  );
}
