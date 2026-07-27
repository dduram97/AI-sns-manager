import type { DatabaseClient } from "../lib/supabase";
import { rowCountFrom, traceQuery } from "../lib/dbTrace";
import {
  assertData,
  mapBrief,
  mapOutcome,
  num,
  todayDate,
  BRIEF_SNAPSHOT_COLS,
  OUTCOME_DAILY_COLS,
  CHANNEL_CONNECTION_COLS,
  type BriefSnapshot,
  type OutcomeDaily,
} from "./shared";

function isDuplicateKeyError(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "23505" ||
    /duplicate key value violates unique constraint/i.test(error.message ?? "")
  );
}

async function readOutcomeForDate(
  db: DatabaseClient,
  date: string,
): Promise<OutcomeDaily | null> {
  const { data, error } = await traceQuery(
    "outcome_daily.by_date",
    () =>
      db
        .from("outcome_daily")
        .select(OUTCOME_DAILY_COLS)
        .eq("date", date)
        .maybeSingle(),
    (r) => (r.data ? 1 : 0),
  );
  if (error) {
    throw new Error(`BriefRepository.ensureOutcomeToday: ${error.message}`);
  }
  return data ? mapOutcome(data as Record<string, unknown>) : null;
}

export function createBriefRepository(db: DatabaseClient) {
  return {
    async getBrief(): Promise<BriefSnapshot> {
      const { data, error } = await traceQuery(
        "brief_snapshots.get",
        () =>
          db
            .from("brief_snapshots")
            .select(BRIEF_SNAPSHOT_COLS)
            .eq("id", true)
            .single(),
        (r) => (r.data ? 1 : 0),
      );
      return mapBrief(
        assertData(data, error, "BriefRepository.getBrief") as Record<
          string,
          unknown
        >,
      );
    },

    /** Last Agent Tick run from status_detail.last_tick_run (ops supervision). */
    async getLastTickRun(): Promise<{
      started_at: string;
      finished_at: string;
      perceptions_processed: number;
      approvals_created: number;
      actions_executed: number;
      actions_failed: number;
      ok: boolean;
      error: string | null;
      source: string | null;
    } | null> {
      const brief = await this.getBrief();
      const raw = brief.status_detail?.last_tick_run;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const r = raw as Record<string, unknown>;
      const started =
        typeof r.started_at === "string"
          ? r.started_at
          : typeof brief.status_detail?.last_tick_at === "string"
            ? brief.status_detail.last_tick_at
            : null;
      if (!started) return null;
      return {
        started_at: started,
        finished_at:
          typeof r.finished_at === "string" ? r.finished_at : started,
        perceptions_processed: Number(r.perceptions_processed ?? 0) || 0,
        approvals_created: Number(r.approvals_created ?? 0) || 0,
        actions_executed: Number(r.actions_executed ?? 0) || 0,
        actions_failed: Number(r.actions_failed ?? 0) || 0,
        ok: r.ok !== false,
        error: typeof r.error === "string" ? r.error : null,
        source: typeof r.source === "string" ? r.source : null,
      };
    },

    async updateBrief(
      patch: Omit<BriefSnapshot, "id" | "updated_at"> & { updated_at?: string },
    ): Promise<BriefSnapshot> {
      const { data, error } = await db
        .from("brief_snapshots")
        .update(patch)
        .eq("id", true)
        .select("*")
        .single();
      return mapBrief(
        assertData(data, error, "BriefRepository.updateBrief") as Record<
          string,
          unknown
        >,
      );
    },

    async ensureOutcomeToday(): Promise<OutcomeDaily> {
      const date = todayDate();

      const existing = await readOutcomeForDate(db, date);
      if (existing) return existing;

      const { error: insertErr } = await db
        .from("outcome_daily")
        .insert({ date });

      if (insertErr && !isDuplicateKeyError(insertErr)) {
        throw new Error(
          `BriefRepository.ensureOutcomeToday.insert: ${insertErr.message}`,
        );
      }

      const row = await readOutcomeForDate(db, date);
      if (row) return row;

      throw new Error(
        "BriefRepository.ensureOutcomeToday: row missing after insert",
      );
    },

    async updateOutcomeToday(
      patch: Partial<
        Pick<
          OutcomeDaily,
          | "intervention_minutes_est"
          | "time_saved_minutes_est"
          | "auto_visit_count"
          | "auto_like_count"
          | "observe_count"
          | "waiting_count"
          | "approval_pending_count"
          | "approval_done_count"
          | "temperature_up_count"
          | "mutual_reaction_count"
          | "lagging_metrics"
        >
      >,
    ): Promise<OutcomeDaily> {
      const date = todayDate();
      await this.ensureOutcomeToday();
      const { data, error } = await db
        .from("outcome_daily")
        .update(patch)
        .eq("date", date)
        .select("*")
        .single();
      return mapOutcome(
        assertData(data, error, "BriefRepository.updateOutcomeToday") as Record<
          string,
          unknown
        >,
      );
    },

    async incrementOutcomeCounters(
      deltas: Partial<
        Record<
          | "auto_visit_count"
          | "auto_like_count"
          | "observe_count"
          | "waiting_count"
          | "approval_pending_count"
          | "approval_done_count"
          | "time_saved_minutes_est",
          number
        >
      >,
    ): Promise<OutcomeDaily> {
      const current = await this.ensureOutcomeToday();
      const patch: Record<string, number> = {};
      for (const [k, v] of Object.entries(deltas)) {
        if (v == null) continue;
        const key = k as keyof OutcomeDaily;
        patch[k] = num(current[key]) + v;
      }
      return this.updateOutcomeToday(patch);
    },

    async listChannelConnectionStatuses(): Promise<Record<string, string>> {
      const { data, error } = await traceQuery(
        "channel_connections.statuses",
        () =>
          db.from("channel_connections").select(CHANNEL_CONNECTION_COLS),
        (r) => rowCountFrom(r.data),
      );
      if (error) {
        throw new Error(
          `BriefRepository.listChannelConnectionStatuses: ${error.message}`,
        );
      }
      const out: Record<string, string> = {};
      for (const row of data ?? []) {
        out[String(row.channel)] = String(row.status);
      }
      return out;
    },
  };
}

export type BriefRepository = ReturnType<typeof createBriefRepository>;
