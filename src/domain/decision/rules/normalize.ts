import type { DecisionContext } from "../../../workers/types";
import { fire } from "../helpers";

/** Pipeline stage 1 — Normalize Events */
export function applyNormalizeEvents(ctx: DecisionContext): void {
  const seen = new Set<string>();
  for (const ev of ctx.perceptions) {
    const key = `${ev.event_type}:${JSON.stringify(ev.payload?.post_id ?? ev.id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ctx.blackboard.normalized_events.push({
      id: ev.id,
      event_type: ev.event_type,
      payload: ev.payload,
    });
  }
  fire(
    ctx,
    "normalize.dedupe",
    "low",
    undefined,
    `events=${ctx.blackboard.normalized_events.length}`,
  );
}
