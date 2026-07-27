/**
 * Context Loader — builds read-only DecisionContext from Supabase.
 */

import { emptyBlackboard } from "../domain/decision/helpers";
import type { Repositories } from "../repositories/index";
import type { DecisionContext, Person } from "./types";

export async function loadDecisionContext(
  repos: Repositories,
  person: Person,
  now = new Date(),
): Promise<DecisionContext> {
  const [
    relationship,
    workflow,
    perceptions,
    recent_activity,
    recent_approvals,
    recent_action_jobs,
    policy,
    outcome_today,
  ] = await Promise.all([
    repos.getRelationship(person.id),
    repos.getActiveWorkflow(person.id),
    repos.listUnprocessedPerceptions(person.id),
    repos.listRecentActivities(person.id),
    repos.listRecentApprovals(person.id),
    repos.listRecentActionJobs(person.id),
    repos.getPolicy(),
    repos.ensureOutcomeToday(),
  ]);

  return {
    now,
    person: { ...person },
    relationship: { ...relationship },
    workflow: workflow ? { ...workflow } : null,
    policy: { ...policy },
    perceptions: perceptions.map((p) => ({ ...p })),
    recent_activity,
    recent_approvals,
    recent_action_jobs,
    outcome_today: { ...outcome_today },
    blackboard: emptyBlackboard(),
  };
}
