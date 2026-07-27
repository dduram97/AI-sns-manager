import type {
  DecisionContext,
  DecisionOutput,
} from "../../../../workers/types";
import { buildExplain, fire } from "../../helpers";

/** Pipeline stage 9 — Policy Gates (means only; does not reorder Goals) */
export function applyPolicyGates(ctx: DecisionContext): void {
  const hour = ctx.now.getHours();
  const { startHour = 23, endHour = 7 } = ctx.policy.quiet_hours;
  const inQuiet =
    startHour > endHour
      ? hour >= startHour || hour < endHour
      : hour >= startHour && hour < endHour;

  if (inQuiet) {
    const delay = new Date(ctx.now);
    delay.setHours(endHour, 0, 0, 0);
    if (delay <= ctx.now) delay.setDate(delay.getDate() + 1);
    ctx.blackboard.schedule = {
      delay_until: delay.toISOString(),
      waiting_for: "quiet_hours",
    };
    fire(ctx, "pol.quiet_hours", "critical", ["natural_interaction"]);
    const explain = buildExplain(ctx, "조용한 시간대 — 실행 지연", [
      "policy quiet hours",
    ]);
    const terminal: DecisionOutput = {
      kind: "delay",
      delay_until: delay.toISOString(),
      waiting_for: "quiet_hours",
      ...explain,
      workflow_patch: {
        current_state: "waiting",
        waiting_until: delay.toISOString(),
        waiting_for: "quiet_hours",
      },
    };
    ctx.blackboard.terminal = terminal;
    return;
  }

  const limits = ctx.policy.daily_limits;
  const o = ctx.outcome_today;
  const ranked = [...ctx.blackboard.action_candidates].sort(
    (a, b) => b.score - a.score,
  );
  const top = ranked.find((c) => c.action_type !== "observe") ?? ranked[0];

  if (
    top?.action_type === "like" &&
    limits.like != null &&
    o.auto_like_count >= limits.like
  ) {
    fire(ctx, "pol.daily_like_cap", "critical", ["minimize_user_time"]);
    ctx.blackboard.terminal = {
      kind: "skip",
      ...buildExplain(ctx, "일일 공감 한도 도달", ["daily like cap"]),
    };
    return;
  }

  if (
    top?.action_type === "visit" &&
    limits.visit != null &&
    o.auto_visit_count >= limits.visit
  ) {
    fire(ctx, "pol.daily_visit_cap", "critical", ["minimize_user_time"]);
    ctx.blackboard.terminal = {
      kind: "skip",
      ...buildExplain(ctx, "일일 방문 한도 도달", ["daily visit cap"]),
    };
    return;
  }

  if (
    !ctx.policy.low_risk_auto &&
    top &&
    top.risk === "low" &&
    top.action_type !== "observe"
  ) {
    fire(ctx, "pol.low_risk_auto_off", "critical", ["minimize_user_time"]);
    ctx.blackboard.terminal = {
      kind: "observe",
      ...buildExplain(ctx, "저위험 자동 비활성 — 관찰만", [
        "low_risk_auto off",
      ]),
    };
    return;
  }

  fire(ctx, "pol.gates_pass", "normal", ["minimize_user_time"]);
}
