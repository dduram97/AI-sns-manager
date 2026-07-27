import { Suspense } from "react";

import { AgentBriefPanelCollapsible } from "@/components/brief/AgentBriefPanelCollapsible";
import { ActivitySummarySection } from "@/components/brief/ActivitySummarySection";
import { AgentStatusSection } from "@/components/brief/AgentStatusSection";
import {
  AgentBriefActivitySkeleton,
  AgentBriefApprovalSkeleton,
  AgentBriefKpiSkeleton,
  AgentBriefRelationshipSkeleton,
  AgentBriefStatusSkeleton,
} from "@/components/brief/AgentBriefSkeletons";
import { ApprovalSummarySection } from "@/components/brief/ApprovalSummarySection";
import { BriefKpiSection } from "@/components/brief/BriefKpiSection";
import { RelationshipSummarySection } from "@/components/brief/RelationshipSummarySection";
import {
  getAgentBriefActivitySection,
  getAgentBriefApprovalSection,
  getAgentBriefRelationshipSection,
  getAgentBriefStatusSection,
} from "@/services/getAgentBrief";

/**
 * Reserved for future panel controls (collapse, settings visibility, admin gate).
 * Not wired yet — defaults preserve current always-visible behavior.
 */
export type AgentBriefPanelProps = {
  defaultExpanded?: boolean;
  visible?: boolean;
  adminOnly?: boolean;
};

async function AgentBriefStatusBlock() {
  const data = await getAgentBriefStatusSection();
  return (
    <>
      <AgentStatusSection
        status={data.status}
        statusLabel={data.statusLabel}
        lastTickLabel={data.lastTickLabel}
        syncSummary={data.syncSummary}
      />
      <BriefKpiSection
        interventionMinutes={data.interventionMinutes}
        timeSavedMinutes={data.timeSavedMinutes}
        approvalCount={data.approvalCountSnapshot}
      />
    </>
  );
}

async function AgentBriefActivityBlock() {
  const activity = await getAgentBriefActivitySection();
  return <ActivitySummarySection {...activity} />;
}

async function AgentBriefApprovalBlock() {
  const count = await getAgentBriefApprovalSection();
  return <ApprovalSummarySection count={count} />;
}

async function AgentBriefRelationshipBlock() {
  const relationship = await getAgentBriefRelationshipSection();
  return <RelationshipSummarySection {...relationship} />;
}

/**
 * Agent Brief 5-block panel (Status, KPI, Activity, Approval, Relationship).
 * Single mount point for future collapse, visibility settings, and admin-only display.
 */
export function AgentBriefPanel(_props: AgentBriefPanelProps = {}) {
  return (
    <AgentBriefPanelCollapsible>
      <div className="flex flex-col gap-4" data-agent-brief-panel="">
        <Suspense
          fallback={
            <>
              <AgentBriefStatusSkeleton />
              <AgentBriefKpiSkeleton />
            </>
          }
        >
          <AgentBriefStatusBlock />
        </Suspense>

        <Suspense fallback={<AgentBriefActivitySkeleton />}>
          <AgentBriefActivityBlock />
        </Suspense>

        <Suspense fallback={<AgentBriefApprovalSkeleton />}>
          <AgentBriefApprovalBlock />
        </Suspense>

        <Suspense fallback={<AgentBriefRelationshipSkeleton />}>
          <AgentBriefRelationshipBlock />
        </Suspense>
      </div>
    </AgentBriefPanelCollapsible>
  );
}
