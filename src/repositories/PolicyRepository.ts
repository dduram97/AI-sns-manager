/**
 * PolicyProfile singleton repository (ARCHITECTURE_SPEC — Policy bucket).
 */

import type { DatabaseClient } from "../lib/supabase";
import { traceQuery } from "../lib/dbTrace";
import { assertData, mapPolicy, type PolicyProfile } from "./shared";

export type PolicyUpdatePatch = Partial<{
  preset: PolicyProfile["preset"];
  low_risk_auto: boolean;
  high_risk_auto_comment: boolean;
  high_risk_auto_request: boolean;
  daily_limits: PolicyProfile["daily_limits"];
  quiet_hours: PolicyProfile["quiet_hours"];
  tone: Record<string, unknown>;
  banned_phrases: string[];
  weekly_goals: Record<string, unknown>;
  discover_keywords: string[];
}>;

export function createPolicyRepository(db: DatabaseClient) {
  return {
    async get(): Promise<PolicyProfile> {
      const { data, error } = await traceQuery(
        "policy_profile.get",
        () =>
          db.from("policy_profile").select("*").eq("id", true).single(),
        (r) => (r.data ? 1 : 0),
      );
      return mapPolicy(
        assertData(data, error, "PolicyRepository.get") as Record<
          string,
          unknown
        >,
      );
    },

    async update(patch: PolicyUpdatePatch): Promise<PolicyProfile> {
      const { data, error } = await db
        .from("policy_profile")
        .update(patch)
        .eq("id", true)
        .select("*")
        .single();
      return mapPolicy(
        assertData(data, error, "PolicyRepository.update") as Record<
          string,
          unknown
        >,
      );
    },

    async listChannelConnections(): Promise<
      Array<{ channel: string; status: string; last_synced_at: string | null }>
    > {
      const { data, error } = await db
        .from("channel_connections")
        .select("channel, status, last_synced_at")
        .order("channel");
      if (error) {
        throw new Error(
          `PolicyRepository.listChannelConnections: ${error.message}`,
        );
      }
      return (data ?? []).map((r) => ({
        channel: String(r.channel),
        status: String(r.status),
        last_synced_at: r.last_synced_at ? String(r.last_synced_at) : null,
      }));
    },

    /** Ensure blog / threads / instagram rows exist for Supervisor display. */
    async ensureChannelConnectionRows(): Promise<void> {
      for (const channel of ["blog", "threads", "instagram"] as const) {
        const { error } = await db.from("channel_connections").upsert(
          {
            channel,
            status: "disconnected",
          },
          { onConflict: "channel", ignoreDuplicates: true },
        );
        if (error) {
          throw new Error(
            `PolicyRepository.ensureChannelConnectionRows: ${error.message}`,
          );
        }
      }
    },

    async updateChannelStatus(
      channel: "blog" | "threads" | "instagram",
      status: "connected" | "error" | "revoked" | "disconnected",
    ): Promise<void> {
      await this.ensureChannelConnectionRows();
      const { error } = await db
        .from("channel_connections")
        .update({
          status,
          last_synced_at:
            status === "connected" ? new Date().toISOString() : undefined,
        })
        .eq("channel", channel);
      if (error) {
        throw new Error(
          `PolicyRepository.updateChannelStatus: ${error.message}`,
        );
      }
    },
  };
}

export type PolicyRepository = ReturnType<typeof createPolicyRepository>;
