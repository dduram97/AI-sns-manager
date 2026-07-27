/** Discover screen view types — safe for client `import type`. */

import type { DiscoverPolicy } from "@/domain/policy/discoverPolicy";
import type { RelationshipStage } from "@/workers/types";

export type DiscoverPolicyView = DiscoverPolicy;

export interface DiscoverCandidateItem {
  personId: string;
  blogName: string;
  blogId: string | null;
  blogUrl: string | null;
  matchedKeywords: string[];
  recommendReasons: string[];
  relationshipValue: number;
  stage: RelationshipStage;
  snippet: string | null;
  workflowId: string | null;
}

export interface DiscoverScreenData {
  policy: DiscoverPolicyView;
  candidates: DiscoverCandidateItem[];
}
