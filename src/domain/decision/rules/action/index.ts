import type {
  ActionCandidate,
  DecisionContext,
} from "../../../../workers/types";
import { fire } from "../../helpers";

function push(ctx: DecisionContext, c: ActionCandidate, ruleId: string) {
  ctx.blackboard.action_candidates.push(c);
  fire(
    ctx,
    ruleId,
    c.risk === "high" ? "high" : "normal",
    c.supports_goals,
    c.reason_short,
  );
}

/**
 * Pipeline stage 7 — Action Candidate Generation
 * Produces a candidate array; Emit selects via Priority + Goal.
 */
export function applyActionCandidateGeneration(ctx: DecisionContext): void {
  const stage = ctx.workflow?.current_stage ?? ctx.relationship.stage;
  const hasNewPost = ctx.blackboard.normalized_events.some(
    (e) => e.event_type === "new_post",
  );
  const postEvent = ctx.blackboard.normalized_events.find(
    (e) => e.event_type === "new_post",
  );
  const target_ref = {
    post_id: postEvent?.payload?.post_id ?? "unknown-post",
    title: postEvent?.payload?.title ?? "새 글",
  };
  const flags = ctx.blackboard.relationship_eval.flags;
  const risk = ctx.blackboard.risk.level;

  const visits = ctx.recent_action_jobs.filter(
    (j) =>
      j.action_type === "visit" && ["executed", "planned"].includes(j.status),
  ).length;
  const likes = ctx.recent_action_jobs.filter(
    (j) =>
      j.action_type === "like" && ["executed", "planned"].includes(j.status),
  ).length;

  // Always allow observe as fallback candidate
  const observe: ActionCandidate = {
    action_type: "observe",
    risk: "low",
    reason_short: "관찰만",
    score: 10 + (risk === "high" ? 25 : 0),
    priority_band: "observe",
    supports_goals: ["minimize_user_time", "natural_interaction"],
    estimated_user_time_cost: 0,
  };

  // VIP neglect → visit / like / comment
  if (
    flags.includes("vip_neglect") ||
    (stage === "vip" && flags.includes("stale_touch"))
  ) {
    if (visits < 1 || flags.includes("stale_visit")) {
      push(
        ctx,
        {
          action_type: "visit",
          risk: "low",
          reason_short: "VIP 방치 회복: 방문",
          score: 90,
          priority_band: "vip_neglect",
          supports_goals: ["relationship_quality"],
          estimated_user_time_cost: 0,
          channel: "blog",
          target_ref,
        },
        "act.vip_visit",
      );
    }
    if (hasNewPost) {
      if (likes < 1) {
        push(
          ctx,
          {
            action_type: "like",
            risk: "low",
            reason_short: "VIP 방치 회복: 공감",
            score: 88,
            priority_band: "vip_neglect",
            supports_goals: ["relationship_quality"],
            estimated_user_time_cost: 0,
            channel: "blog",
            target_ref,
          },
          "act.vip_like",
        );
      }
      if (risk !== "high" && likes >= 1) {
        const body = "오랜만에 글 잘 봤습니다. 늘 응원하고 있어요!";
        push(
          ctx,
          {
            action_type: "comment",
            risk: "high",
            reason_short: "VIP 방치 회복: 댓글",
            score: 92,
            priority_band: "vip_neglect",
            supports_goals: ["relationship_quality", "natural_interaction"],
            estimated_user_time_cost: 0.8,
            channel: "blog",
            target_ref,
            draft_body: body,
            draft_alternatives: [
              "글 감사히 읽었습니다. 건강과 일상 응원합니다!",
              "포스팅 보고 힘이 나네요. 수고 많으십니다.",
            ],
          },
          "act.vip_comment",
        );
        ctx.blackboard.draft = {
          action_type: "comment",
          body,
          alternatives: [
            "글 감사히 읽었습니다. 건강과 일상 응원합니다!",
            "포스팅 보고 힘이 나네요. 수고 많으십니다.",
          ],
          target_ref,
          channel: "blog",
        };
      }
    }
  }

  // Discover / Warming path
  if (stage === "discover" || stage === "warming") {
    if (visits < 1) {
      push(
        ctx,
        {
          action_type: "visit",
          risk: "low",
          reason_short: "워밍: 방문",
          score: 60,
          priority_band: stage === "discover" ? "discover" : "warming_done",
          supports_goals: ["sustained_growth", "natural_interaction"],
          estimated_user_time_cost: 0,
          channel: "blog",
          target_ref,
        },
        "act.warming_visit",
      );
    }
    if (likes < 1 && (hasNewPost || visits >= 1)) {
      push(
        ctx,
        {
          action_type: "like",
          risk: "low",
          reason_short: "워밍: 공감",
          score: 65,
          priority_band: "warming_done",
          supports_goals: ["sustained_growth", "natural_interaction"],
          estimated_user_time_cost: 0,
          channel: "blog",
          target_ref,
        },
        "act.warming_like",
      );
    }
    if (visits >= 1 && likes >= 1 && risk !== "high") {
      const body =
        "안녕하세요! 관심사가 비슷해 보여 서로이웃 신청드립니다. 잘 부탁드려요 🙂";
      push(
        ctx,
        {
          action_type: "neighbor_request",
          risk: "high",
          reason_short: "워밍 완료 → 서로이웃 신청",
          score: 70,
          priority_band: "warming_done",
          supports_goals: ["sustained_growth", "natural_interaction"],
          estimated_user_time_cost: 1,
          channel: "blog",
          target_ref,
          draft_body: body,
          draft_alternatives: [
            "반갑습니다. 포스팅 자주 보고 있어 서로이웃 신청해요!",
            "좋은 글 감사히 보고 있습니다. 서로이웃 맺고 싶어요.",
          ],
        },
        "act.request_after_warming",
      );
      ctx.blackboard.draft = {
        action_type: "neighbor_request",
        body,
        alternatives: [
          "반갑습니다. 포스팅 자주 보고 있어 서로이웃 신청해요!",
          "좋은 글 감사히 보고 있습니다. 서로이웃 맺고 싶어요.",
        ],
        target_ref,
        channel: "blog",
      };
    }
  }

  // waiting_new_post: like if post arrives, else observe
  if (stage === "waiting_new_post" && hasNewPost && likes < 1) {
    push(
      ctx,
      {
        action_type: "like",
        risk: "low",
        reason_short: "대기 중 새 글 공감",
        score: 68,
        priority_band: "new_post",
        supports_goals: ["natural_interaction", "relationship_quality"],
        estimated_user_time_cost: 0,
        channel: "blog",
        target_ref,
      },
      "act.wait_like",
    );
  }

  // Maintain / VIP / Early + new post → like (once) then comment approval
  if (
    ["maintain", "vip", "early_relationship", "approval_pending"].includes(
      stage,
    ) &&
    hasNewPost
  ) {
    if (likes < 1) {
      push(
        ctx,
        {
          action_type: "like",
          risk: "low",
          reason_short: "유지: 새 글 공감",
          score: 72,
          priority_band: "new_post",
          supports_goals: ["relationship_quality"],
          estimated_user_time_cost: 0,
          channel: "blog",
          target_ref,
        },
        "act.maintain_like",
      );
    }

    if (
      (likes >= 1 || stage === "vip") &&
      (risk !== "high" || stage === "vip")
    ) {
      const body = "포스팅 잘 봤습니다. 사진 분위기가 정말 좋네요!";
      push(
        ctx,
        {
          action_type: "comment",
          risk: "high",
          reason_short: "유지: 새 글 댓글",
          score: 80,
          priority_band: "new_post",
          supports_goals: ["relationship_quality", "natural_interaction"],
          estimated_user_time_cost: 0.8,
          channel: "blog",
          target_ref,
          draft_body: body,
          draft_alternatives: [
            "글 잘 읽었습니다. 내용이 도움이 많이 됐어요.",
            "오늘 포스팅도 유익하네요. 응원합니다!",
          ],
        },
        "act.maintain_comment",
      );
      ctx.blackboard.draft = {
        action_type: "comment",
        body,
        alternatives: [
          "글 잘 읽었습니다. 내용이 도움이 많이 됐어요.",
          "오늘 포스팅도 유익하네요. 응원합니다!",
        ],
        target_ref,
        channel: "blog",
      };
    }
  }

  // High risk → prefer observe as candidate (still selectable)
  if (risk === "high") {
    observe.score = Math.max(observe.score, 55);
    observe.reason_short = "고위험 신호 — 관찰 우선 후보";
  }

  push(ctx, observe, "act.observe_only");
}
