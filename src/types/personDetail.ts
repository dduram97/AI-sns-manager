/** Person detail view types — safe for client `import type`. */

import type { DecisionExplainView } from "@/lib/decisionExplain";
import type {
  ActivityItem,
  ApprovalItem,
  Person,
  RelationshipState,
  Workflow,
} from "@/workers/types";

export interface TimelineActivityItem extends ActivityItem {
  workflowStage: string | null;
  decisionExplain: DecisionExplainView | null;
}

export interface PersonDetailViewModel {
  person: Person;
  relationship: RelationshipState;
  activeWorkflow: Workflow | null;
  workflows: Workflow[];
  approvals: ApprovalItem[];
  activities: ActivityItem[];
  timeline: TimelineActivityItem[];
  decisions: DecisionExplainView[];
  stageChanges: ActivityItem[];
  openApprovalCount: number;
}
