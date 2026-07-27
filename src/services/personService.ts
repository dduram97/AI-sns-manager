import type { PersonListItem } from "@/lib/personListUtils";
import "server-only";

import { createServiceClient } from "@/lib/supabase";
import { runWithDbTrace } from "@/lib/dbTrace";
import {
  toDecisionExplainView,
  type DecisionExplainView,
} from "@/lib/decisionExplain";
import { createSupervisorRepos } from "@/repositories/index";
import type {
  TimelineActivityItem,
  PersonDetailViewModel,
} from "@/types/personDetail";
import type {
  ActivityItem,
  ActivityKind,
} from "@/workers/types";

export type { PersonListItem, PersonSort } from "@/lib/personListUtils";
export { filterAndSortPersons } from "@/lib/personListUtils";
export type {
  PersonDetailViewModel,
  TimelineActivityItem,
} from "@/types/personDetail";

const EXPLAIN_KINDS = new Set<ActivityKind>([
  "stage_changed",
  "approval_created",
  "blocked",
  "waiting",
]);

export async function listPersonCrm(): Promise<PersonListItem[]> {
  return loadPersonListPage();
}

export async function loadPersonListPage(): Promise<PersonListItem[]> {
  return runWithDbTrace("people", async () => {
    const repos = createSupervisorRepos(createServiceClient());
    const rows = await repos.person.listCrmRows();
    const counts = await repos.approval.countOpenByPersonIds(
      rows.map((r) => r.person.id),
    );

    return rows.map((r) => ({
      person: r.person,
      relationship: r.relationship,
      workflow: r.workflow,
      approvalCount: counts[r.person.id] ?? 0,
    }));
  });
}

export async function getPersonDetail(
  personId: string,
): Promise<PersonDetailViewModel | null> {
  const repos = createSupervisorRepos(createServiceClient());
  const person = await repos.person.getById(personId);
  if (!person) return null;

  const [
    relationship,
    activeWorkflow,
    workflows,
    approvals,
    activities,
    stageChanges,
    openApprovalCount,
    recentDecisions,
  ] = await Promise.all([
    repos.person.getRelationship(personId),
    repos.person.getActiveWorkflow(personId),
    repos.person.listWorkflowsByPerson(personId),
    repos.approval.listRecentByPerson(personId, 30),
    repos.activity.listTimelineByPerson(personId, 50),
    repos.activity.listStageChangesByPerson(personId, 30),
    repos.approval.countOpenByPerson(personId),
    repos.person.listRecentDecisionsByPerson(personId, 40),
  ]);

  const decisionIds = [
    ...activities.map((a) => a.decision_id).filter((id): id is string => Boolean(id)),
    ...recentDecisions.map((d) => d.id),
  ];
  const decisionRows = await repos.person.getDecisionsByIds(decisionIds);
  const explainById = new Map(
    decisionRows.map((r) => [r.id, toDecisionExplainView(r)] as const),
  );
  for (const d of recentDecisions) {
    if (!explainById.has(d.id)) explainById.set(d.id, toDecisionExplainView(d));
  }

  const stageByWorkflowId = new Map(
    workflows.map((w) => [w.id, w.current_stage] as const),
  );
  const timeline: TimelineActivityItem[] = [...activities]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .map((a) => {
      const linked = a.decision_id
        ? (explainById.get(a.decision_id) ?? null)
        : null;
      const needsExplain =
        Boolean(linked) &&
        (EXPLAIN_KINDS.has(a.kind) || Boolean(a.decision_id));
      return {
        ...a,
        workflowStage: a.workflow_id
          ? (stageByWorkflowId.get(a.workflow_id) ??
            activeWorkflow?.current_stage ??
            null)
          : (activeWorkflow?.current_stage ?? null),
        decisionExplain: needsExplain ? linked : null,
      };
    });

  const decisions = recentDecisions.map(toDecisionExplainView);

  return {
    person,
    relationship,
    activeWorkflow,
    workflows,
    approvals,
    activities,
    timeline,
    decisions,
    stageChanges,
    openApprovalCount,
  };
}
