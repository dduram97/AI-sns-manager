import type { DatabaseClient } from "../lib/supabase";
import type { NeighborExclusion } from "@/types/neighborScreen";
import { rowCountFrom, traceQuery } from "../lib/dbTrace";
import { NEIGHBOR_EXCLUSION_COLS } from "./shared";

export type { NeighborExclusion } from "@/types/neighborScreen";

export function createNeighborExclusionRepository(db: DatabaseClient) {
  return {
    async list(): Promise<NeighborExclusion[]> {
      const { data, error } = await traceQuery(
        "neighbor_exclusions.list",
        () =>
          db
            .from("neighbor_exclusions")
            .select(NEIGHBOR_EXCLUSION_COLS)
            .order("excluded_at", { ascending: false }),
        (r) => rowCountFrom(r.data),
      );
      if (error) {
        // Table may not exist yet before migration — soft empty
        if (/neighbor_exclusions|schema cache/i.test(error.message)) {
          console.warn(
            "[neighbor_exclusions]",
            error.message,
            "— run migration 004",
          );
          return [];
        }
        throw new Error(`NeighborExclusion.list: ${error.message}`);
      }
      return (data ?? []).map((r) => {
        const row = r as Record<string, unknown>;
        return {
          blog_id: String(row.blog_id),
          blog_name: typeof row.blog_name === "string" ? row.blog_name : null,
          blog_url: typeof row.blog_url === "string" ? row.blog_url : null,
          note: typeof row.note === "string" ? row.note : null,
          excluded_at: String(row.excluded_at ?? new Date().toISOString()),
        };
      });
    },

    async isExcluded(blogId: string): Promise<boolean> {
      const { data, error } = await db
        .from("neighbor_exclusions")
        .select("blog_id")
        .eq("blog_id", blogId)
        .maybeSingle();
      if (error) {
        if (/neighbor_exclusions|schema cache/i.test(error.message)) return false;
        throw new Error(`NeighborExclusion.isExcluded: ${error.message}`);
      }
      return Boolean(data);
    },

    async exclude(input: {
      blog_id: string;
      blog_name?: string | null;
      blog_url?: string | null;
      note?: string | null;
    }): Promise<NeighborExclusion> {
      const { data, error } = await db
        .from("neighbor_exclusions")
        .upsert(
          {
            blog_id: input.blog_id.trim(),
            blog_name: input.blog_name ?? null,
            blog_url: input.blog_url ?? null,
            note: input.note ?? null,
            excluded_at: new Date().toISOString(),
          },
          { onConflict: "blog_id" },
        )
        .select("*")
        .single();
      if (error) throw new Error(`NeighborExclusion.exclude: ${error.message}`);
      const row = data as Record<string, unknown>;
      return {
        blog_id: String(row.blog_id),
        blog_name: typeof row.blog_name === "string" ? row.blog_name : null,
        blog_url: typeof row.blog_url === "string" ? row.blog_url : null,
        note: typeof row.note === "string" ? row.note : null,
        excluded_at: String(row.excluded_at),
      };
    },

    async allowAgain(blogId: string): Promise<void> {
      const { error } = await db
        .from("neighbor_exclusions")
        .delete()
        .eq("blog_id", blogId);
      if (error) throw new Error(`NeighborExclusion.allowAgain: ${error.message}`);
    },
  };
}
