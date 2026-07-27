/**
 * Discover Supervisor — review Agent candidates (no search / no manual discover run).
 */

import "server-only";

import { createServiceClient } from "@/lib/supabase";
import { getDiscoverPolicy } from "@/domain/policy/discoverPolicy";
import { createSupervisorRepos } from "@/repositories/index";
import type {
  DiscoverCandidateItem,
  DiscoverPolicyView,
  DiscoverScreenData,
} from "@/types/discover";
import type { Person, RelationshipStage, Workflow } from "@/workers/types";

export type {
  DiscoverCandidateItem,
  DiscoverPolicyView,
  DiscoverScreenData,
} from "@/types/discover";

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isVerifyMeta(meta: Record<string, unknown>): boolean {
  return meta.verify === true;
}

function isDismissed(meta: Record<string, unknown>): boolean {
  return meta.supervisor_review === "dismissed";
}

function isInterested(meta: Record<string, unknown>): boolean {
  return meta.supervisor_review === "interested";
}

function toCandidate(
  person: Person,
  stage: RelationshipStage,
  score: number,
  workflow: Workflow | null,
): DiscoverCandidateItem {
  const meta = person.discover_meta ?? {};
  const matched = asStringArray(meta.matched_keywords);
  const reasons = asStringArray(meta.reasons);
  const recommendScore =
    typeof meta.recommend_score === "number"
      ? meta.recommend_score
      : typeof meta.keyword_relevance === "number"
        ? meta.keyword_relevance
        : score;

  return {
    personId: person.id,
    blogName: person.display_name,
    blogId: typeof meta.blog_id === "string" ? meta.blog_id : null,
    blogUrl: typeof meta.blog_url === "string" ? meta.blog_url : null,
    matchedKeywords: matched,
    recommendReasons:
      reasons.length > 0
        ? reasons
        : [
            ...(matched.length > 0 ? [`키워드 일치: ${matched.join(", ")}`] : []),
            meta.recently_active === true ? "최근 활동" : null,
          ].filter((x): x is string => Boolean(x)),
    relationshipValue: Math.max(0, Math.min(100, Math.round(Number(recommendScore) || 0))),
    stage,
    snippet: typeof meta.snippet === "string" ? meta.snippet : null,
    workflowId: workflow?.id ?? null,
  };
}

export async function getDiscoverScreenData(): Promise<DiscoverScreenData> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);
  const policy = getDiscoverPolicy(await repos.policy.get());

  const rows = await repos.person.listCrmRows();
  const candidates: DiscoverCandidateItem[] = [];

  for (const row of rows) {
    const meta = row.person.discover_meta ?? {};
    if (isVerifyMeta(meta)) continue;
    if (isDismissed(meta) || isInterested(meta)) continue;
    if (row.relationship.stage !== "discover") continue;

    candidates.push(
      toCandidate(
        row.person,
        row.relationship.stage,
        row.relationship.score,
        row.workflow,
      ),
    );
  }

  candidates.sort((a, b) => b.relationshipValue - a.relationshipValue);

  return { policy, candidates };
}

/**
 * 관심 있음 — keep/link Person, advance discover → warming for Agent pipeline.
 */
export async function markDiscoverInterested(personId: string): Promise<void> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);
  const person = await repos.person.getById(personId);
  if (!person) throw new Error("Person not found");

  const meta = person.discover_meta ?? {};
  if (isVerifyMeta(meta)) throw new Error("Verify fixture cannot be reviewed");

  const blogId = typeof meta.blog_id === "string" ? meta.blog_id : null;
  if (blogId) {
    const existingId = await repos.person.findPersonIdByBlogId(blogId);
    if (existingId && existingId !== personId) {
      // Already linked elsewhere — mark this candidate dismissed duplicate, keep existing
      await repos.person.updateDiscoverMeta(personId, {
        supervisor_review: "dismissed",
        reviewed_at: new Date().toISOString(),
        dismiss_reason: "duplicate_blog_linked",
        linked_person_id: existingId,
      });
      const wf = await repos.person.getActiveWorkflow(personId);
      if (wf) {
        await repos.person.updateWorkflow(wf.id, {
          current_state: "cancelled",
          next_action: "none",
          blocked_reason: "duplicate_discover_candidate",
        });
      }
      await repos.activity.insert({
        workflow_id: wf?.id ?? null,
        person_id: personId,
        action_job_id: null,
        decision_id: null,
        kind: "observed",
        summary: `발굴 중복 · 기존 Person 연결 유지 (${existingId})`,
      });
      return;
    }
    await repos.person.upsertBlogIdentity({
      person_id: personId,
      blog_id: blogId,
      profile_snapshot: {
        url: meta.blog_url,
        name: person.display_name,
      },
    });
  }

  await repos.person.updateDiscoverMeta(personId, {
    supervisor_review: "interested",
    reviewed_at: new Date().toISOString(),
  });

  await repos.person.updateRelationship(personId, {
    stage: "warming",
    temperature: Math.max(15, (await repos.person.getRelationship(personId)).temperature),
  });

  const workflow = await repos.person.getActiveWorkflow(personId);
  if (workflow) {
    await repos.person.updateWorkflow(workflow.id, {
      current_stage: "warming",
      current_state: "active",
      next_action: "visit",
      goal: "warming_to_request",
      blocked_reason: null,
    });
  }

  await repos.activity.insert({
    workflow_id: workflow?.id ?? null,
    person_id: personId,
    action_job_id: null,
    decision_id: null,
    kind: "stage_changed",
    summary: "발굴 관심 있음 · discover → warming",
  });
}

/**
 * 관심 없음 — Decision 학습 데이터(weekly_goals.discover_learning) 저장 + 후보 제외.
 */
export async function markDiscoverDismissed(personId: string): Promise<void> {
  const db = createServiceClient();
  const repos = createSupervisorRepos(db);

  const person = await repos.person.getById(personId);
  if (!person) throw new Error("Person not found");
  const meta = person.discover_meta ?? {};
  if (isVerifyMeta(meta)) throw new Error("Verify fixture cannot be reviewed");

  const now = new Date().toISOString();
  await repos.person.updateDiscoverMeta(personId, {
    supervisor_review: "dismissed",
    reviewed_at: now,
  });

  const workflow = await repos.person.getActiveWorkflow(personId);
  if (workflow) {
    await repos.person.updateWorkflow(workflow.id, {
      current_state: "cancelled",
      next_action: "none",
      blocked_reason: "supervisor_dismissed_discover",
    });
  }

  await repos.person.updateRelationship(personId, {
    stage: "risk",
  });

  const policy = await repos.policy.get();
  const goals = { ...(policy.weekly_goals ?? {}) };
  const learning =
    goals.discover_learning && typeof goals.discover_learning === "object"
      ? ({ ...(goals.discover_learning as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};
  const dismissals = Array.isArray(learning.dismissals)
    ? [...(learning.dismissals as unknown[])]
    : [];
  dismissals.unshift({
    person_id: personId,
    blog_id: meta.blog_id ?? null,
    display_name: person.display_name,
    matched_keywords: asStringArray(meta.matched_keywords),
    reasons: asStringArray(meta.reasons),
    recommend_score: meta.recommend_score ?? meta.keyword_relevance ?? null,
    at: now,
    signal: "supervisor_not_interested",
  });
  learning.dismissals = dismissals.slice(0, 200);
  learning.updated_at = now;

  const excludeExtra = asStringArray(meta.matched_keywords);
  const currentExclude = asStringArray(
    (goals.discover_exclude_keywords as unknown) ??
      ((goals.discover_policy as Record<string, unknown> | undefined)
        ?.exclude_keywords as unknown),
  );
  const mergedExclude = [...new Set([...currentExclude, ...excludeExtra])].slice(
    0,
    80,
  );

  await repos.policy.update({
    weekly_goals: {
      ...goals,
      discover_learning: learning,
      discover_exclude_keywords: mergedExclude,
      discover_policy: {
        ...((goals.discover_policy as Record<string, unknown>) ?? {}),
        exclude_keywords: mergedExclude,
      },
    },
  });

  await repos.activity.insert({
    workflow_id: workflow?.id ?? null,
    person_id: personId,
    action_job_id: null,
    decision_id: null,
    kind: "observed",
    summary: "발굴 관심 없음 · 학습 신호 저장",
  });
}

