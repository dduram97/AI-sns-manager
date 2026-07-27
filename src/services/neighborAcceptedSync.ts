/**
 * Keep accepted neighbors in persons.discover_meta after mutual-request success.
 * Does not touch Approval / ActionJob / CDP execute paths.
 */

import "server-only";

import { parseNeighborSource } from "@/domain/neighbor/neighborSource";
import { parseNeighborRelationStatus } from "@/domain/neighbor/relationStatus";
import { createServiceClient } from "@/lib/supabase";
import { createSupervisorRepos } from "@/repositories/index";

function logNeighborSyncError(
  where: string,
  err: unknown,
  extra?: Record<string, unknown>,
) {
  console.error("[neighbor-sync-error]", {
    where,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    ...extra,
  });
}

/**
 * After neighbor_request ActionJob succeeds — upsert person as accepted neighbor.
 * Preserves existing_sync / manual source; otherwise sets neighbor_request.
 */
export async function upsertAcceptedNeighborAfterRequest(
  personId: string,
): Promise<{ ok: boolean }> {
  try {
    const repos = createSupervisorRepos(createServiceClient());
    const person = await repos.person.getById(personId);
    if (!person) return { ok: false };

    const meta = person.discover_meta ?? {};
    const prevSource = parseNeighborSource(meta);
    const now = new Date().toISOString();

    const patch: Record<string, unknown> = {
      neighbor_relation_status: "accepted",
      neighbor_accepted_at:
        typeof meta.neighbor_accepted_at === "string" &&
        meta.neighbor_accepted_at
          ? meta.neighbor_accepted_at
          : now,
      neighbor_synced_at: now,
      neighbor_last_checked_at: now,
      neighbor_status_checked_at: now,
      neighbor_excluded: false,
    };

    if (!meta.neighbor_requested_at) {
      patch.neighbor_requested_at = now;
    }

    // Do not overwrite existing_sync / manual provenance
    if (prevSource !== "existing_sync" && prevSource !== "manual") {
      patch.neighbor_source = "neighbor_request";
      patch.source = "neighbor_request";
    }

    await repos.person.updateDiscoverMeta(personId, patch);

    try {
      const rel = await repos.person.getRelationship(personId);
      if (
        rel.stage === "discover" ||
        rel.stage === "warming" ||
        rel.stage === "waiting_new_post"
      ) {
        await repos.person.updateRelationship(personId, {
          stage: "early_relationship",
          temperature: Math.max(rel.temperature ?? 0, 50),
        });
      }
    } catch {
      /* relationship optional */
    }

    return { ok: true };
  } catch (err) {
    logNeighborSyncError("upsertAcceptedNeighborAfterRequest", err, {
      personId,
    });
    return { ok: false };
  }
}

/**
 * Light DB reconcile before feed collect (not on every status poll).
 * Does not call Naver CDP / buddy list scrape.
 */
export async function reconcileAcceptedNeighborsForFeed(): Promise<{
  fixed: number;
}> {
  const repos = createSupervisorRepos(createServiceClient());
  const db = createServiceClient();
  let fixed = 0;
  const now = new Date().toISOString();

  try {
    const { data: jobs, error } = await db
      .from("action_jobs")
      .select("person_id")
      .eq("action_type", "neighbor_request")
      .eq("status", "executed")
      .order("executed_at", { ascending: false })
      .limit(300);
    if (error) {
      logNeighborSyncError("reconcile.jobQuery", error);
    } else {
      const seen = new Set<string>();
      for (const row of jobs ?? []) {
        const personId = (row as { person_id?: string }).person_id;
        if (!personId || seen.has(personId)) continue;
        seen.add(personId);
        try {
          const person = await repos.person.getById(personId);
          if (!person) continue;
          const meta = person.discover_meta ?? {};
          if (parseNeighborRelationStatus(meta) === "accepted") continue;
          const res = await upsertAcceptedNeighborAfterRequest(personId);
          if (res.ok) fixed += 1;
        } catch (err) {
          logNeighborSyncError("reconcile.jobPerson", err, { personId });
        }
      }
    }
  } catch (err) {
    logNeighborSyncError("reconcile.jobs", err);
  }

  try {
    const crm = await repos.person.listCrmRows();
    for (const row of crm) {
      const stage = row.relationship.stage;
      if (
        stage !== "maintain" &&
        stage !== "vip" &&
        stage !== "early_relationship"
      ) {
        continue;
      }
      const meta = row.person.discover_meta ?? {};
      if (meta.verify === true || meta.neighbor_excluded === true) continue;
      const blogId =
        typeof meta.blog_id === "string" ? meta.blog_id.trim() : "";
      if (!blogId) continue;
      if (parseNeighborRelationStatus(meta) === "accepted") continue;

      try {
        const prevSource = parseNeighborSource(meta);
        const patch: Record<string, unknown> = {
          neighbor_relation_status: "accepted",
          neighbor_accepted_at:
            typeof meta.neighbor_accepted_at === "string" &&
            meta.neighbor_accepted_at
              ? meta.neighbor_accepted_at
              : now,
          neighbor_synced_at: now,
          neighbor_excluded: false,
        };
        if (!prevSource) {
          patch.neighbor_source = "manual";
          patch.source = "manual";
        }
        await repos.person.updateDiscoverMeta(row.person.id, patch);
        fixed += 1;
      } catch (err) {
        logNeighborSyncError("reconcile.stagePerson", err, {
          personId: row.person.id,
        });
      }
    }
  } catch (err) {
    logNeighborSyncError("reconcile.crm", err);
  }

  if (fixed > 0) {
    console.info(`[neighbor] reconcile accepted fixed: ${fixed}`);
  }
  return { fixed };
}

/** Any person that looks like a stored neighbor (for first-time UI). */
export async function hasStoredNeighborRecords(): Promise<boolean> {
  try {
    const repos = createSupervisorRepos(createServiceClient());
    const rows = await repos.person.listCrmRows();
    for (const row of rows) {
      const meta = row.person.discover_meta ?? {};
      if (meta.verify === true) continue;
      if (parseNeighborRelationStatus(meta) === "accepted") return true;
      if (parseNeighborSource(meta) != null) return true;
      if (
        row.relationship.stage === "maintain" ||
        row.relationship.stage === "vip" ||
        row.relationship.stage === "early_relationship"
      ) {
        const blogId =
          typeof meta.blog_id === "string" ? meta.blog_id.trim() : "";
        if (blogId) return true;
      }
    }
    return false;
  } catch (err) {
    logNeighborSyncError("hasStoredNeighborRecords", err);
    return false;
  }
}
