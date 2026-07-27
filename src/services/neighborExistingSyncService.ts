/**
 * Sync existing Naver neighbors (BuddyList) into persons DB.
 * Does not create Approvals or ActionJobs — feed pool picks them up via accepted status.
 */

import "server-only";

import { NaverBlogAdapter } from "@/adapters/naver/NaverBlogAdapter";
import type { NaverBuddyListItem } from "@/adapters/naver/buddyList";
import {
  EXISTING_NEIGHBOR_UPSERT_BATCH,
  type ExistingNeighborDto,
  type ExistingNeighborFetchResult,
  type ExistingNeighborSyncSummary,
  type ExistingNeighborUpsertBatchResult,
} from "@/domain/neighbor/existingSyncTypes";
import { parseNeighborSource } from "@/domain/neighbor/neighborSource";
import { parseNeighborRelationStatus } from "@/domain/neighbor/relationStatus";
import { createServiceClient } from "@/lib/supabase";
import {
  createRepositories,
  createSupervisorRepos,
} from "@/repositories/index";

export type {
  ExistingNeighborDto,
  ExistingNeighborFetchResult,
  ExistingNeighborSyncSummary,
  ExistingNeighborUpsertBatchResult,
} from "@/domain/neighbor/existingSyncTypes";
export { EXISTING_NEIGHBOR_UPSERT_BATCH } from "@/domain/neighbor/existingSyncTypes";

export async function fetchExistingNeighborsFromNaver(): Promise<ExistingNeighborFetchResult> {
  const adapter = new NaverBlogAdapter();
  const fetchedAt = new Date().toISOString();
  const result = await adapter.listExistingNeighbors();

  const debug = result.debug;
  const pageAccessOk =
    debug?.pages.some((p) => p.pageAccess === "ok") === true;
  const notFound =
    debug?.pages.some((p) => p.pageAccess === "not_found") === true;
  const loginOk = debug?.loginOk !== false && result.ok;
  const blogResolved = Boolean(result.ownBlogId);
  const extractOk = result.items.length > 0;
  const candidateElements =
    debug?.pages.reduce((s, p) => s + p.candidateElements, 0) ?? 0;
  const emptyNeighbors =
    pageAccessOk &&
    !extractOk &&
    (candidateElements > 0 ||
      debug?.pages.some((p) =>
        p.signals.some((s) => s.includes("body_empty_neighbors")),
      ) === true);

  const checklist: string[] = [];
  if (loginOk) checklist.push("✅ 로그인 확인 완료");
  else checklist.push("❌ 로그인 확인 실패 · CDP Chrome 네이버 로그인을 확인하세요");

  if (blogResolved) checklist.push(`✅ 블로그 확인 완료 (${result.ownBlogId})`);
  else checklist.push("❌ 블로그 ID를 확인하지 못했습니다");

  if (notFound) {
    checklist.push(
      `❌ 이웃 페이지 접근 실패 · 블로그 '${result.ownBlogId}'를 찾을 수 없습니다 (404)`,
    );
  } else if (pageAccessOk) {
    checklist.push("✅ 이웃 페이지 접근 완료");
  } else if (debug?.pages.some((p) => p.pageAccess === "login_required")) {
    checklist.push("❌ 이웃 페이지 접근 실패 · 권한/로그인 필요");
  } else if (debug?.pages.some((p) => p.pageAccess === "error")) {
    checklist.push("❌ 페이지 로딩 실패");
  } else {
    checklist.push("❌ 이웃 페이지 접근 실패");
  }

  if (extractOk) {
    checklist.push(`✅ 이웃 목록 추출 완료 (${result.items.length}명)`);
  } else if (emptyNeighbors) {
    checklist.push("❌ 현재 이웃 0명 · 목록이 비어 있습니다");
  } else if (pageAccessOk && candidateElements === 0) {
    checklist.push("❌ 이웃 목록 추출 실패 · 추출 대상 DOM을 찾지 못했습니다");
  } else if (pageAccessOk) {
    checklist.push("❌ 이웃 목록 추출 실패");
  } else {
    checklist.push("❌ 이웃 목록 추출 실패");
  }

  const diagnostics = {
    ownBlogIdSource: debug?.ownBlogIdSource ?? "unknown",
    loginOk,
    blogResolved,
    pageAccessOk,
    extractOk,
    emptyNeighbors,
    pageAccessSummary: (debug?.pages ?? []).map(
      (p) =>
        `${p.pageAccess} · ${p.finalUrl || p.requestedUrl} · candidates=${p.candidateElements} · extracted=${p.extracted}`,
    ),
    checklist,
    reasons: debug?.reasons ?? [],
    candidateElements,
    sampleHrefs: (debug?.pages ?? []).flatMap((p) => p.sampleHrefs).slice(0, 8),
    pagesTried: debug?.pages.length ?? 0,
  };

  console.log("[neighbor-sync]");
  console.log(`  page url: ${debug?.pages[0]?.finalUrl ?? "(none)"}`);
  console.log(`  blogId: ${result.ownBlogId}`);
  console.log(`  blogId source: ${diagnostics.ownBlogIdSource}`);
  console.log(`  login status: ${loginOk ? "ok" : "need_login"}`);
  console.log(`  candidates: ${candidateElements}`);
  console.log(`  extracted blogs: ${result.items.length}`);
  console.log(`  save result: pending`);
  console.log(`  checklist: ${JSON.stringify(checklist)}`);

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.errorMessage ||
        "네이버 이웃 목록을 가져오지 못했습니다. CDP 로그인 상태를 확인해 주세요.",
      ownBlogId: result.ownBlogId,
      neighbors: [],
      fetchedAt,
      diagnostics,
    };
  }

  if (result.items.length === 0) {
    return {
      ok: true,
      message: checklist.filter((l) => l.startsWith("❌")).join(" · ") ||
        "이웃 목록 추출 실패",
      ownBlogId: result.ownBlogId,
      neighbors: [],
      fetchedAt,
      diagnostics,
    };
  }

  return {
    ok: true,
    message: `네이버에서 이웃 ${result.items.length}명을 확인했습니다.`,
    ownBlogId: result.ownBlogId,
    neighbors: result.items.map(
      (item: NaverBuddyListItem): ExistingNeighborDto => ({
        blogId: item.blogId,
        blogName: item.blogName,
        blogUrl: item.blogUrl,
        relationKind: item.relationKind,
      }),
    ),
    fetchedAt,
    diagnostics,
  };
}

export async function upsertExistingNeighborsBatch(
  neighbors: ExistingNeighborDto[],
): Promise<ExistingNeighborUpsertBatchResult> {
  const repos = createSupervisorRepos(createServiceClient());
  const workerRepos = createRepositories(createServiceClient());
  const out: ExistingNeighborUpsertBatchResult = {
    processed: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    lastName: null,
  };
  const now = new Date().toISOString();

  for (const n of neighbors) {
    const blogId = n.blogId?.trim();
    if (!blogId) {
      out.skipped += 1;
      continue;
    }
    out.processed += 1;
    out.lastName = n.blogName || blogId;

    try {
      const existingId = await repos.person.findPersonIdByBlogId(blogId);
      const blogUrl =
        n.blogUrl?.trim() || `https://m.blog.naver.com/${blogId}`;
      const displayName = (n.blogName || blogId).slice(0, 80);

      if (existingId) {
        const person = await repos.person.getById(existingId);
        if (person?.discover_meta?.verify === true) {
          out.skipped += 1;
          continue;
        }
        const meta = person?.discover_meta ?? {};
        const prevSource = parseNeighborSource(meta);
        const prevStatus = parseNeighborRelationStatus(meta);

        const patch: Record<string, unknown> = {
          blog_id: blogId,
          blog_url: blogUrl,
          nickname: displayName,
          neighbor_relation_status: "accepted",
          neighbor_synced_at: now,
          neighbor_last_checked_at: now,
          neighbor_status_checked_at: now,
          neighbor_excluded: false,
        };
        if (!meta.neighbor_accepted_at) {
          patch.neighbor_accepted_at = now;
        }
        // Preserve request/manual provenance; otherwise mark as existing sync
        if (!prevSource || prevSource === "existing_sync") {
          patch.neighbor_source = "existing_sync";
          patch.source = "existing_sync";
        }
        // If previously failed/requested from app flow but they appear on buddy list → accepted
        if (prevStatus !== "accepted") {
          patch.neighbor_accepted_at = now;
        }

        await repos.person.updateDiscoverMeta(existingId, patch);
        try {
          const rel = await repos.person.getRelationship(existingId);
          if (
            rel.stage === "discover" ||
            rel.stage === "warming" ||
            rel.stage === "waiting_new_post"
          ) {
            await workerRepos.updateRelationship(existingId, {
              stage: "early_relationship",
              temperature: 50,
            });
          }
        } catch {
          // relationship row may be missing — create path handles new persons
        }
        out.updated += 1;
        continue;
      }

      const meta: Record<string, unknown> = {
        blog_id: blogId,
        blog_url: blogUrl,
        nickname: displayName,
        neighbor_source: "existing_sync",
        source: "existing_sync",
        neighbor_relation_status: "accepted",
        neighbor_accepted_at: now,
        neighbor_synced_at: now,
        neighbor_last_checked_at: now,
        neighbor_status_checked_at: now,
        neighbor_excluded: false,
        relation_kind: n.relationKind,
      };

      const person = await workerRepos.createPerson({
        display_name: displayName,
        discover_meta: meta,
      });
      await workerRepos.upsertBlogIdentity({
        person_id: person.id,
        blog_id: blogId,
        profile_snapshot: {
          url: blogUrl,
          name: displayName,
          source: "existing_sync",
        },
      });
      await workerRepos.updateRelationship(person.id, {
        stage: "early_relationship",
        score: 50,
        temperature: 50,
      });
      const workflow = await workerRepos.createWorkflow({
        person_id: person.id,
        current_stage: "early_relationship",
        current_state: "active",
        next_action: "comment",
        last_decision_id: null,
        priority: 55,
        goal: "neighbor_existing_sync",
      });
      await workerRepos.setPersonActiveWorkflow(person.id, workflow.id);
      out.added += 1;
    } catch (err) {
      out.errors.push(
        `${blogId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return out;
}

export async function finalizeExistingNeighborSync(input: {
  ownBlogId: string | null;
  total: number;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}): Promise<ExistingNeighborSyncSummary> {
  const repos = createSupervisorRepos(createServiceClient());
  const policy = await repos.policy.get();
  const lastSyncAt = new Date().toISOString();
  const weekly = {
    ...(policy.weekly_goals ?? {}),
    neighbor_existing_sync: {
      last_sync_at: lastSyncAt,
      own_blog_id: input.ownBlogId,
      last_total: input.total,
      last_added: input.added,
      last_updated: input.updated,
    },
  };
  await repos.policy.update({ weekly_goals: weekly });

  const message =
    input.added + input.updated > 0
      ? `기존 이웃 동기화 완료 · 신규 ${input.added} · 업데이트 ${input.updated}`
      : input.total === 0
        ? "동기화할 이웃이 없습니다."
        : `변경 없음 · 확인 ${input.total}명`;

  return {
    ok: true,
    message,
    ownBlogId: input.ownBlogId,
    total: input.total,
    added: input.added,
    updated: input.updated,
    skipped: input.skipped,
    lastSyncAt,
    errors: input.errors.slice(0, 20),
  };
}

/** One-shot helper for future cron — prefer chunked UI actions. */
export async function syncExistingNeighbors(): Promise<ExistingNeighborSyncSummary> {
  const fetched = await fetchExistingNeighborsFromNaver();
  if (!fetched.ok) {
    return {
      ok: false,
      message: fetched.message,
      ownBlogId: fetched.ownBlogId,
      total: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      lastSyncAt: fetched.fetchedAt,
      errors: [fetched.message],
    };
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  const batchSize = EXISTING_NEIGHBOR_UPSERT_BATCH;

  for (let i = 0; i < fetched.neighbors.length; i += batchSize) {
    const chunk = fetched.neighbors.slice(i, i + batchSize);
    const res = await upsertExistingNeighborsBatch(chunk);
    added += res.added;
    updated += res.updated;
    skipped += res.skipped;
    errors.push(...res.errors);
  }

  return finalizeExistingNeighborSync({
    ownBlogId: fetched.ownBlogId,
    total: fetched.neighbors.length,
    added,
    updated,
    skipped,
    errors,
  });
}
