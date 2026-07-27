/** Client-safe person list filter/sort (no Supabase / server deps). */

import type {
  Person,
  RelationshipStage,
  RelationshipState,
  Workflow,
} from "@/workers/types";

export type PersonSort = "priority" | "last_touch" | "temperature";

export interface PersonListItem {
  person: Person;
  relationship: RelationshipState;
  workflow: Workflow | null;
  approvalCount: number;
}

export function filterAndSortPersons(
  items: PersonListItem[],
  opts: {
    q?: string;
    stage?: RelationshipStage | "all";
    sort?: PersonSort;
  },
): PersonListItem[] {
  let next = [...items];
  const q = opts.q?.trim().toLowerCase();
  if (q) {
    next = next.filter((i) => i.person.display_name.toLowerCase().includes(q));
  }
  if (opts.stage && opts.stage !== "all") {
    next = next.filter((i) => i.relationship.stage === opts.stage);
  }

  const sort = opts.sort ?? "priority";
  next.sort((a, b) => {
    if (sort === "temperature") {
      return b.relationship.temperature - a.relationship.temperature;
    }
    if (sort === "last_touch") {
      const at = a.relationship.last_touch_at
        ? new Date(a.relationship.last_touch_at).getTime()
        : 0;
      const bt = b.relationship.last_touch_at
        ? new Date(b.relationship.last_touch_at).getTime()
        : 0;
      return bt - at;
    }
    const ap = a.workflow?.priority ?? -1;
    const bp = b.workflow?.priority ?? -1;
    if (bp !== ap) return bp - ap;
    if (b.approvalCount !== a.approvalCount) return b.approvalCount - a.approvalCount;
    return b.relationship.temperature - a.relationship.temperature;
  });

  return next;
}
