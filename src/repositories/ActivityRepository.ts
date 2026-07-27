import type { DatabaseClient } from "../lib/supabase";
import { rowCountFrom, traceQuery } from "../lib/dbTrace";
import {
  assertData,
  mapActivity,
  ACTIVITY_DAY_COLS,
  type ActivityItem,
  type ActivityKind,
} from "./shared";

export function createActivityRepository(db: DatabaseClient) {
  return {
    async listForDate(date: string): Promise<ActivityItem[]> {
      const start = `${date}T00:00:00.000Z`;
      const end = `${date}T23:59:59.999Z`;
      const { data, error } = await traceQuery(
        "activity_items.by_date",
        () =>
          db
            .from("activity_items")
            .select(ACTIVITY_DAY_COLS)
            .gte("created_at", start)
            .lte("created_at", end)
            .order("created_at", { ascending: false }),
        (r) => rowCountFrom(r.data),
      );
      return assertData(data, error, "ActivityRepository.listForDate").map((r) =>
        mapActivity(r as Record<string, unknown>),
      );
    },

    async listRecentByPerson(personId: string, limit = 20): Promise<ActivityItem[]> {
      const { data, error } = await db
        .from("activity_items")
        .select("*")
        .eq("person_id", personId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return assertData(data, error, "ActivityRepository.listRecentByPerson").map((r) =>
        mapActivity(r as Record<string, unknown>),
      );
    },

    async listTimelineByPerson(personId: string, limit = 50): Promise<ActivityItem[]> {
      return this.listRecentByPerson(personId, limit);
    },

    async listStageChangesByPerson(personId: string, limit = 30): Promise<ActivityItem[]> {
      const { data, error } = await db
        .from("activity_items")
        .select("*")
        .eq("person_id", personId)
        .eq("kind", "stage_changed")
        .order("created_at", { ascending: false })
        .limit(limit);
      return assertData(data, error, "ActivityRepository.listStageChangesByPerson").map(
        (r) => mapActivity(r as Record<string, unknown>),
      );
    },

    async insert(input: {
      workflow_id: string | null;
      person_id: string | null;
      action_job_id: string | null;
      decision_id: string | null;
      kind: ActivityKind;
      summary: string;
    }): Promise<ActivityItem> {
      const { data, error } = await db
        .from("activity_items")
        .insert(input)
        .select("*")
        .single();
      return mapActivity(
        assertData(data, error, "ActivityRepository.insert") as Record<string, unknown>,
      );
    },
  };
}

export type ActivityRepository = ReturnType<typeof createActivityRepository>;
