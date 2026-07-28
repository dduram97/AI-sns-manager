import type { DatabaseClient } from "../lib/supabase";
import { rowCountFrom, traceQuery } from "../lib/dbTrace";
import {
  resolveAvailableModes,
  type ApprovalExecuteMode,
} from "../lib/approvalExecuteMode";
import {
  isCommentSituation,
  type CommentSituation,
} from "../lib/commentSituation";
import type {
  ApprovalHistoryItem,
  ApprovalHistoryPage,
  ApprovalInboxItem,
  ApprovalInboxSource,
} from "../types/approvalInbox";
import {
  assertData,
  mapActionJob,
  mapApproval,
  mapDecision,
  mapPerson,
  mapWorkflow,
  APPROVAL_OPEN_COLS,
  ACTION_JOB_INBOX_COLS,
  DECISION_EXPLAIN_COLS,
  PERSON_CRM_COLS,
  WORKFLOW_CRM_COLS,
  type ActionJob,
  type ApprovalItem,
  type DecisionRecord,
  type Person,
  type Workflow,
} from "./shared";

export type {
  ApprovalHistoryItem,
  ApprovalHistoryPage,
  ApprovalInboxItem,
  ApprovalInboxSource,
} from "../types/approvalInbox";

function inboxSourceFromTargetRef(
  ref: Record<string, unknown> | null | undefined,
): ApprovalInboxSource {
  if (!ref) return null;
  if (ref.source === "neighbor_feed" || ref.neighbor_feed === true) {
    return "neighbor_feed";
  }
  return null;
}

function actionLabel(type: string): string {
  switch (type) {
    case "comment":
      return "댓글";
    case "like":
      return "공감";
    case "neighbor_request":
      return "서로이웃 신청";
    case "threads_reply":
      return "Threads 답글";
    default:
      return type;
  }
}

function isBundledLikeHold(job: ActionJob): boolean {
  if (job.action_type !== "like") return false;
  return (
    job.status === "planned" ||
    job.status === "pending_approval" ||
    job.status === "approved" ||
    job.status === "failed" ||
    job.status === "executed"
  );
}

const ACTION_JOB_BUNDLE_COLS = "id, action_type, status, bundle_id";

async function fetchRowsByIds(
  db: DatabaseClient,
  table: string,
  cols: string,
  idCol: string,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(ids.filter(Boolean))];
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await db.from(table).select(cols).in(idCol, chunk);
    if (error) {
      throw new Error(`ApprovalRepository.fetchRowsByIds ${table}: ${error.message}`);
    }
    for (const row of data ?? []) {
      const rec = row as unknown as Record<string, unknown>;
      map.set(String(rec[idCol]), rec);
    }
  }
  return map;
}

function buildOpenInboxItem(input: {
  approval: ApprovalItem;
  person: Person;
  job: ActionJob;
  workflow: Workflow;
  decisionById: Map<string, DecisionRecord>;
  jobsByBundle: Map<string, ActionJob[]>;
}): ApprovalInboxItem {
  const { approval, person, job, workflow, decisionById, jobsByBundle } = input;
  const ctx = approval.presented_context ?? {};

  let mutualRequest: ApprovalInboxItem["mutualRequest"] = null;
  if (
    job.action_type === "neighbor_request" ||
    ctx.approval_kind === "mutual_request"
  ) {
    const reasons = Array.isArray(ctx.recommend_reasons)
      ? ctx.recommend_reasons.filter((x): x is string => typeof x === "string")
      : [];
    mutualRequest = {
      blogName:
        typeof ctx.blog_name === "string" && ctx.blog_name
          ? ctx.blog_name
          : person.display_name,
      recommendReasons: reasons,
    };
  }

  let decisionExplain: ApprovalInboxItem["decisionExplain"] = null;
  if (job.decision_id) {
    const rec = decisionById.get(job.decision_id);
    if (rec) {
      const detail = rec.reason_detail ?? {};
      const reasons = Array.isArray(detail.reasons)
        ? detail.reasons.filter((x): x is string => typeof x === "string")
        : [];
      const rule_ids = Array.isArray(detail.rule_ids)
        ? detail.rule_ids.filter((x): x is string => typeof x === "string")
        : [];
      decisionExplain = {
        decisionId: rec.id,
        reason_short: rec.reason_short,
        explanation:
          typeof detail.explanation === "string" && detail.explanation
            ? detail.explanation
            : rec.reason_short,
        reasons: reasons.length > 0 ? reasons : [rec.reason_short],
        rule_ids,
      };
    }
  }

  const bundleId = job.bundle_id;
  let hasBundledLike = false;
  if (bundleId) {
    const bundled = jobsByBundle.get(bundleId) ?? [];
    hasBundledLike = bundled.some(
      (j) => j.id !== job.id && isBundledLikeHold(j),
    );
  }
  const availableModes = resolveAvailableModes({
    actionType: job.action_type,
    hasBundledLike,
  });

  const ctxSituation = ctx.comment_situation;
  const refSituation = job.target_ref?.comment_situation;
  const commentSituation = isCommentSituation(ctxSituation)
    ? ctxSituation
    : isCommentSituation(refSituation)
      ? refSituation
      : null;
  const postTitle =
    typeof ctx.post_title === "string"
      ? ctx.post_title
      : typeof job.target_ref?.title === "string"
        ? job.target_ref.title
        : null;
  const postSummary =
    typeof ctx.post_summary === "string"
      ? ctx.post_summary
      : typeof job.target_ref?.content_summary === "string"
        ? job.target_ref.content_summary
        : null;
  const source = inboxSourceFromTargetRef(job.target_ref);
  const publishedAt =
    typeof job.target_ref?.published_at === "string" &&
    job.target_ref.published_at
      ? job.target_ref.published_at
      : typeof ctx.published_at === "string" && ctx.published_at
        ? ctx.published_at
        : null;

  return {
    approval,
    person,
    job,
    workflow,
    reasonShort:
      typeof ctx.reason_short === "string" ? ctx.reason_short : "승인 필요",
    draftBody: job.draft_body ?? "",
    actionLabel: actionLabel(job.action_type),
    bundleId,
    hasBundledLike,
    availableModes,
    commentSituation,
    postTitle,
    postSummary,
    source,
    publishedAt,
    mutualRequest,
    decisionExplain,
  };
}

export function createApprovalRepository(db: DatabaseClient) {
  return {
    async listOpen(): Promise<ApprovalItem[]> {
      const { data, error } = await traceQuery(
        "approval_items.list_open",
        () =>
          db
            .from("approval_items")
            .select(APPROVAL_OPEN_COLS)
            .is("resolved_at", null)
            .order("inbox_priority", { ascending: false })
            .order("created_at", { ascending: true }),
        (r) => rowCountFrom(r.data),
      );
      return assertData(data, error, "ApprovalRepository.listOpen").map((r) =>
        mapApproval(r as Record<string, unknown>),
      );
    },

    /** Lightweight: person_ids with open neighbor_request approvals (2 queries). */
    async listOpenNeighborRequestPersonIds(): Promise<Set<string>> {
      const { data: approvals, error: apprErr } = await traceQuery(
        "approval_items.open_neighbor_join",
        () =>
          db
            .from("approval_items")
            .select("person_id, action_job_id")
            .is("resolved_at", null),
        (r) => rowCountFrom(r.data),
      );
      if (apprErr) {
        throw new Error(
          `ApprovalRepository.listOpenNeighborRequestPersonIds: ${apprErr.message}`,
        );
      }
      const rows = approvals ?? [];
      if (rows.length === 0) return new Set();

      const jobIds = [
        ...new Set(
          rows
            .map((r) => String((r as { action_job_id?: string }).action_job_id))
            .filter(Boolean),
        ),
      ];
      const jobRows = await fetchRowsByIds(
        db,
        "action_jobs",
        "id, action_type",
        "id",
        jobIds,
      );
      const neighborJobIds = new Set<string>();
      for (const [id, row] of jobRows) {
        if (String(row.action_type) === "neighbor_request") {
          neighborJobIds.add(id);
        }
      }

      const personIds = new Set<string>();
      for (const row of rows) {
        const rec = row as { person_id?: string; action_job_id?: string };
        const jid = String(rec.action_job_id ?? "");
        if (neighborJobIds.has(jid) && rec.person_id) {
          personIds.add(String(rec.person_id));
        }
      }
      return personIds;
    },

    async listOpenInbox(): Promise<ApprovalInboxItem[]> {
      const open = await this.listOpen();
      if (open.length === 0) return [];

      const personIds = [...new Set(open.map((a) => a.person_id))];
      const jobIds = [...new Set(open.map((a) => a.action_job_id))];
      const wfIds = [...new Set(open.map((a) => a.workflow_id))];

      const [personRows, jobRows, wfRows] = await Promise.all([
        traceQuery(
          "persons.by_ids_inbox",
          () => fetchRowsByIds(db, "persons", PERSON_CRM_COLS, "id", personIds),
          (m) => m.size,
        ),
        traceQuery(
          "action_jobs.by_ids_inbox",
          () =>
            fetchRowsByIds(
              db,
              "action_jobs",
              ACTION_JOB_INBOX_COLS,
              "id",
              jobIds,
            ),
          (m) => m.size,
        ),
        traceQuery(
          "workflows.by_ids_inbox",
          () =>
            fetchRowsByIds(
              db,
              "workflows",
              WORKFLOW_CRM_COLS,
              "id",
              wfIds,
            ),
          (m) => m.size,
        ),
      ]);

      const personMap = new Map<string, Person>();
      for (const [id, row] of personRows) {
        personMap.set(id, mapPerson(row));
      }
      const jobMap = new Map<string, ActionJob>();
      for (const [id, row] of jobRows) {
        jobMap.set(id, mapActionJob(row));
      }
      const wfMap = new Map<string, Workflow>();
      for (const [id, row] of wfRows) {
        wfMap.set(id, mapWorkflow(row));
      }

      const jobs = [...jobMap.values()];
      const decisionIds = [
        ...new Set(
          jobs.map((j) => j.decision_id).filter((id): id is string => Boolean(id)),
        ),
      ];
      const decisionRows = await traceQuery(
        "decision_records.by_ids_inbox",
        () =>
          fetchRowsByIds(
            db,
            "decision_records",
            DECISION_EXPLAIN_COLS,
            "id",
            decisionIds,
          ),
        (m) => m.size,
      );
      const decisionById = new Map<string, DecisionRecord>();
      for (const [id, row] of decisionRows) {
        decisionById.set(id, mapDecision(row));
      }

      const bundleIds = [
        ...new Set(
          jobs
            .map((j) => j.bundle_id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const jobsByBundle = new Map<string, ActionJob[]>();
      if (bundleIds.length > 0) {
        const bundleRowMap = await traceQuery(
          "action_jobs.by_bundle_ids",
          async () => {
            const map = new Map<string, Record<string, unknown>>();
            const chunkSize = 100;
            for (let i = 0; i < bundleIds.length; i += chunkSize) {
              const chunk = bundleIds.slice(i, i + chunkSize);
              const { data, error } = await db
                .from("action_jobs")
                .select(ACTION_JOB_BUNDLE_COLS)
                .in("bundle_id", chunk);
              if (error) {
                throw new Error(
                  `ApprovalRepository.listOpenInbox bundles: ${error.message}`,
                );
              }
              for (const row of data ?? []) {
                map.set(
                  String((row as { id?: string }).id),
                  row as unknown as Record<string, unknown>,
                );
              }
            }
            return map;
          },
          (m) => m.size,
        );
        for (const row of bundleRowMap.values()) {
          const job = mapActionJob(row);
          const bid = job.bundle_id;
          if (!bid) continue;
          const list = jobsByBundle.get(bid) ?? [];
          list.push(job);
          jobsByBundle.set(bid, list);
        }
      }

      const items: ApprovalInboxItem[] = [];
      for (const approval of open) {
        const person = personMap.get(approval.person_id);
        const job = jobMap.get(approval.action_job_id);
        const workflow = wfMap.get(approval.workflow_id);
        if (!person || !job || !workflow) continue;
        items.push(
          buildOpenInboxItem({
            approval,
            person,
            job,
            workflow,
            decisionById,
            jobsByBundle,
          }),
        );
      }
      return items;
    },

    async listResolvedInbox(opts?: {
      page?: number;
      pageSize?: number;
      fromIso?: string;
      toIso?: string;
      rangeLabel?: string;
      sourceMode?: "all" | "neighbor_feed_only" | "exclude_neighbor_feed";
    }): Promise<ApprovalHistoryPage> {
      const pageSize = Math.min(Math.max(opts?.pageSize ?? 15, 1), 50);
      const page = Math.max(opts?.page ?? 1, 1);
      const fromIso = opts?.fromIso;
      const toIso = opts?.toIso;
      const rangeLabel = opts?.rangeLabel ?? "전체";
      const sourceMode = opts?.sourceMode ?? "all";
      const needsSourceFilter = sourceMode !== "all";

      let listQ = db
        .from("approval_items")
        .select("*")
        .not("resolved_at", "is", null)
        .order("resolved_at", { ascending: false });
      if (fromIso) listQ = listQ.gte("resolved_at", fromIso);
      if (toIso) listQ = listQ.lte("resolved_at", toIso);
      // When filtering by source, over-fetch then paginate in memory.
      if (needsSourceFilter) {
        listQ = listQ.limit(400);
      } else {
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        listQ = listQ.range(from, to);
      }
      const { data, error } = await listQ;
      const rows = assertData(
        data,
        error,
        "ApprovalRepository.listResolvedInbox",
      );

      const mapped: ApprovalHistoryItem[] = [];
      for (const row of rows) {
        const approval = mapApproval(row as Record<string, unknown>);
        if (!approval.resolved_at) continue;

        const [personRes, jobRes] = await Promise.all([
          db.from("persons").select("*").eq("id", approval.person_id).single(),
          db
            .from("action_jobs")
            .select("*")
            .eq("id", approval.action_job_id)
            .single(),
        ]);
        if (personRes.error || !personRes.data) continue;
        if (jobRes.error || !jobRes.data) continue;

        const person = mapPerson(personRes.data as Record<string, unknown>);
        const job = mapActionJob(jobRes.data as Record<string, unknown>);
        const isNeighborFeed =
          inboxSourceFromTargetRef(job.target_ref) === "neighbor_feed";
        if (sourceMode === "neighbor_feed_only" && !isNeighborFeed) continue;
        if (sourceMode === "exclude_neighbor_feed" && isNeighborFeed) continue;

        const ctx = approval.presented_context ?? {};
        const modeRaw = ctx.last_execute_mode;
        const executeMode =
          modeRaw === "comment" || modeRaw === "like" || modeRaw === "both"
            ? modeRaw
            : null;
        const postTitle =
          typeof ctx.post_title === "string"
            ? ctx.post_title
            : typeof job.target_ref?.title === "string"
              ? job.target_ref.title
              : null;

        mapped.push({
          approval,
          person,
          job,
          draftBody: job.draft_body ?? "",
          postTitle,
          executeMode,
          resolvedAt: approval.resolved_at,
          success:
            job.status === "executed" || job.status === "skipped_policy",
          actionLabel: actionLabel(job.action_type),
        });
      }

      let total: number;
      let items: ApprovalHistoryItem[];
      if (needsSourceFilter) {
        total = mapped.length;
        const from = (page - 1) * pageSize;
        items = mapped.slice(from, from + pageSize);
      } else {
        let countQ = db
          .from("approval_items")
          .select("*", { count: "exact", head: true })
          .not("resolved_at", "is", null);
        if (fromIso) countQ = countQ.gte("resolved_at", fromIso);
        if (toIso) countQ = countQ.lte("resolved_at", toIso);
        const { count, error: countErr } = await countQ;
        if (countErr) {
          throw new Error(
            `ApprovalRepository.listResolvedInbox count: ${countErr.message}`,
          );
        }
        total = count ?? 0;
        items = mapped;
      }

      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const successCount = needsSourceFilter
        ? mapped.filter((i) => i.success).length
        : await this.countSuccessfulResolved({
            fromIso,
            toIso,
          });

      return {
        items,
        total,
        page: Math.min(page, totalPages),
        pageSize,
        totalPages,
        successCount,
        rangeLabel,
        fromIso: fromIso ?? "",
        toIso: toIso ?? "",
      };
    },

    async countSuccessfulResolved(opts?: {
      fromIso?: string;
      toIso?: string;
    }): Promise<number> {
      let q = db
        .from("approval_items")
        .select("id, action_job_id")
        .not("resolved_at", "is", null);
      if (opts?.fromIso) q = q.gte("resolved_at", opts.fromIso);
      if (opts?.toIso) q = q.lte("resolved_at", opts.toIso);
      const { data, error } = await q;
      if (error) {
        throw new Error(
          `ApprovalRepository.countSuccessfulResolved: ${error.message}`,
        );
      }
      const rows = data ?? [];
      if (rows.length === 0) return 0;

      const jobIds = rows
        .map((r) => (r as { action_job_id?: string }).action_job_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (jobIds.length === 0) return 0;

      // Batch in chunks (PostgREST URL limits)
      const successIds = new Set<string>();
      const chunkSize = 100;
      for (let i = 0; i < jobIds.length; i += chunkSize) {
        const chunk = jobIds.slice(i, i + chunkSize);
        const { data: jobs, error: jobErr } = await db
          .from("action_jobs")
          .select("id, status")
          .in("id", chunk)
          .in("status", ["executed", "skipped_policy"]);
        if (jobErr) {
          throw new Error(
            `ApprovalRepository.countSuccessfulResolved jobs: ${jobErr.message}`,
          );
        }
        for (const j of jobs ?? []) {
          const id = (j as { id?: string }).id;
          if (id) successIds.add(id);
        }
      }
      return jobIds.filter((id) => successIds.has(id)).length;
    },

    async updatePresentedContext(
      approvalId: string,
      patch: Record<string, unknown>,
    ): Promise<ApprovalItem> {
      const current = await this.getById(approvalId);
      if (!current) throw new Error("Approval not found");
      const presented_context = {
        ...(current.presented_context ?? {}),
        ...patch,
      };
      const { data, error } = await db
        .from("approval_items")
        .update({ presented_context })
        .eq("id", approvalId)
        .is("resolved_at", null)
        .select("*")
        .single();
      return mapApproval(
        assertData(
          data,
          error,
          "ApprovalRepository.updatePresentedContext",
        ) as Record<string, unknown>,
      );
    },

    /** Open approval whose action_job_id points at this job (if any). */
    async findOpenByActionJobId(
      actionJobId: string,
    ): Promise<ApprovalItem | null> {
      const { data, error } = await db
        .from("approval_items")
        .select("*")
        .eq("action_job_id", actionJobId)
        .is("resolved_at", null)
        .maybeSingle();
      if (error) {
        throw new Error(
          `ApprovalRepository.findOpenByActionJobId: ${error.message}`,
        );
      }
      return data
        ? mapApproval(data as Record<string, unknown>)
        : null;
    },

    /**
     * Point open approval at a replacement ActionJob (retry).
     * Does not resolve the approval.
     */
    async repointActionJob(
      approvalId: string,
      newActionJobId: string,
    ): Promise<ApprovalItem> {
      const { data, error } = await db
        .from("approval_items")
        .update({ action_job_id: newActionJobId })
        .eq("id", approvalId)
        .is("resolved_at", null)
        .select("*")
        .single();
      return mapApproval(
        assertData(
          data,
          error,
          "ApprovalRepository.repointActionJob",
        ) as Record<string, unknown>,
      );
    },

    /**
     * Clone a failed primary job as pending_approval for retry.
     * Leaves the failed job status unchanged; stamps superseded_by on it.
     */
    async cloneFailedJobAsPendingApproval(
      failedJob: ActionJob,
      opts?: { draftBody?: string | null },
    ): Promise<ActionJob> {
      if (failedJob.status !== "failed") {
        throw new Error(
          `cloneFailedJobAsPendingApproval: expected failed, got ${failedJob.status}`,
        );
      }
      const draft =
        opts?.draftBody !== undefined
          ? opts.draftBody
          : failedJob.draft_body;
      const { data, error } = await db
        .from("action_jobs")
        .insert({
          parent_workflow_id: failedJob.parent_workflow_id,
          person_id: failedJob.person_id,
          channel: failedJob.channel,
          action_type: failedJob.action_type,
          risk: failedJob.risk,
          status: "pending_approval",
          draft_body: draft,
          draft_alternatives: failedJob.draft_alternatives,
          target_ref: {
            ...failedJob.target_ref,
            retried_from: failedJob.id,
            // fresh execution counters for the replacement job
            retry_count: 0,
          },
          decision_id: failedJob.decision_id,
          inbox_priority: failedJob.inbox_priority,
          bundle_id: failedJob.bundle_id,
          error: null,
          executed_at: null,
          reject_reason: null,
        })
        .select("*")
        .single();
      const created = mapActionJob(
        assertData(
          data,
          error,
          "ApprovalRepository.cloneFailedJobAsPendingApproval",
        ) as Record<string, unknown>,
      );

      await this.updateJobTargetRef(failedJob.id, {
        ...failedJob.target_ref,
        superseded_by: created.id,
        superseded_at: new Date().toISOString(),
      });

      return created;
    },

    async updateJobTargetRef(
      jobId: string,
      target_ref: Record<string, unknown>,
    ): Promise<ActionJob> {
      const { data, error } = await db
        .from("action_jobs")
        .update({ target_ref })
        .eq("id", jobId)
        .select("*")
        .single();
      return mapActionJob(
        assertData(
          data,
          error,
          "ApprovalRepository.updateJobTargetRef",
        ) as Record<string, unknown>,
      );
    },

    async updateJobDraftAndAlternatives(
      jobId: string,
      draftBody: string,
      draftAlternatives?: string[] | null,
    ): Promise<ActionJob> {
      const patch: Record<string, unknown> = { draft_body: draftBody };
      if (draftAlternatives !== undefined) {
        patch.draft_alternatives = draftAlternatives;
      }
      const { data, error } = await db
        .from("action_jobs")
        .update(patch)
        .eq("id", jobId)
        .eq("status", "pending_approval")
        .select("*")
        .single();
      return mapActionJob(
        assertData(
          data,
          error,
          "ApprovalRepository.updateJobDraftAndAlternatives",
        ) as Record<string, unknown>,
      );
    },

    async listJobsByBundleId(bundleId: string): Promise<ActionJob[]> {
      const { data, error } = await db
        .from("action_jobs")
        .select("*")
        .eq("bundle_id", bundleId)
        .order("created_at", { ascending: true });
      return assertData(
        data,
        error,
        "ApprovalRepository.listJobsByBundleId",
      ).map((r) => mapActionJob(r as Record<string, unknown>));
    },

    async markJobSkippedPolicy(
      jobId: string,
      reason: string,
    ): Promise<ActionJob> {
      const { data, error } = await db
        .from("action_jobs")
        .update({
          status: "skipped_policy",
          reject_reason: reason,
          error: null,
        })
        .eq("id", jobId)
        .in("status", ["planned", "pending_approval", "approved", "failed"])
        .select("*")
        .single();
      return mapActionJob(
        assertData(
          data,
          error,
          "ApprovalRepository.markJobSkippedPolicy",
        ) as Record<string, unknown>,
      );
    },

    async getById(id: string): Promise<ApprovalItem | null> {
      const { data, error } = await db
        .from("approval_items")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error)
        throw new Error(`ApprovalRepository.getById: ${error.message}`);
      return data ? mapApproval(data as Record<string, unknown>) : null;
    },

    async getActionJob(jobId: string): Promise<ActionJob> {
      const { data, error } = await db
        .from("action_jobs")
        .select("*")
        .eq("id", jobId)
        .single();
      return mapActionJob(
        assertData(data, error, "ApprovalRepository.getActionJob") as Record<
          string,
          unknown
        >,
      );
    },

    async create(input: {
      workflow_id: string;
      action_job_id: string;
      person_id: string;
      inbox_priority: number;
      presented_context: Record<string, unknown>;
    }): Promise<ApprovalItem> {
      const { data, error } = await db
        .from("approval_items")
        .insert(input)
        .select("*")
        .single();
      return mapApproval(
        assertData(data, error, "ApprovalRepository.create") as Record<
          string,
          unknown
        >,
      );
    },

    async resolve(id: string): Promise<ApprovalItem> {
      const { data, error } = await db
        .from("approval_items")
        .update({ resolved_at: new Date().toISOString() })
        .eq("id", id)
        .is("resolved_at", null)
        .select("*")
        .single();
      return mapApproval(
        assertData(data, error, "ApprovalRepository.resolve") as Record<
          string,
          unknown
        >,
      );
    },

    async updateJobDraft(jobId: string, draftBody: string): Promise<ActionJob> {
      const { data, error } = await db
        .from("action_jobs")
        .update({ draft_body: draftBody })
        .eq("id", jobId)
        .eq("status", "pending_approval")
        .select("*")
        .single();
      return mapActionJob(
        assertData(data, error, "ApprovalRepository.updateJobDraft") as Record<
          string,
          unknown
        >,
      );
    },

    async markJobApproved(
      jobId: string,
      draftBody?: string,
    ): Promise<ActionJob> {
      const patch: Record<string, unknown> = { status: "approved" };
      if (draftBody != null) patch.draft_body = draftBody;
      const { data, error } = await db
        .from("action_jobs")
        .update(patch)
        .eq("id", jobId)
        .select("*")
        .single();
      return mapActionJob(
        assertData(data, error, "ApprovalRepository.markJobApproved") as Record<
          string,
          unknown
        >,
      );
    },

    async markJobRejected(
      jobId: string,
      reason: string | null,
    ): Promise<ActionJob> {
      const { data, error } = await db
        .from("action_jobs")
        .update({ status: "rejected", reject_reason: reason })
        .eq("id", jobId)
        .select("*")
        .single();
      return mapActionJob(
        assertData(data, error, "ApprovalRepository.markJobRejected") as Record<
          string,
          unknown
        >,
      );
    },

    async markJobExecuted(jobId: string): Promise<ActionJob> {
      const now = new Date().toISOString();
      const { data, error } = await db
        .from("action_jobs")
        .update({ status: "executed", executed_at: now, error: null })
        .eq("id", jobId)
        .select("*")
        .single();
      return mapActionJob(
        assertData(data, error, "ApprovalRepository.markJobExecuted") as Record<
          string,
          unknown
        >,
      );
    },

    /**
     * Soft skip / excluded — not counted as success quota or hard failure.
     * Stores execution_result on target_ref for Admin UI.
     */
    async markJobSkipped(
      jobId: string,
      input: {
        status: "skipped" | "excluded";
        reasonCode: string;
        reasonMessage: string;
        failedStep?: string;
        outcome?: string;
        detail?: Record<string, unknown>;
      },
    ): Promise<ActionJob> {
      const existing = await this.getActionJob(jobId);
      const prev =
        existing.target_ref &&
        typeof existing.target_ref === "object" &&
        !Array.isArray(existing.target_ref)
          ? { ...(existing.target_ref as Record<string, unknown>) }
          : {};
      const target_ref = {
        ...prev,
        execution_result: {
          outcome: input.outcome ?? input.status,
          reason_code: input.reasonCode,
          reason_message: input.reasonMessage,
          failed_step: input.failedStep ?? "unknown",
          detail: input.detail,
          failure_reason: {
            code: input.reasonCode,
            message: input.reasonMessage,
          },
        },
      };
      const { data, error } = await db
        .from("action_jobs")
        .update({
          status: input.status,
          error: `[${input.reasonCode}] ${input.reasonMessage}`.slice(0, 2000),
          target_ref,
        })
        .eq("id", jobId)
        .in("status", ["running", "planned", "approved", "failed"])
        .select("*")
        .single();
      return mapActionJob(
        assertData(
          data,
          error,
          "ApprovalRepository.markJobSkipped",
        ) as Record<string, unknown>,
      );
    },

    /** Live execution: planned|approved|failed → running */
    async markJobRunning(jobId: string): Promise<ActionJob> {
      const { data, error } = await db
        .from("action_jobs")
        .update({ status: "running", error: null })
        .eq("id", jobId)
        .in("status", ["planned", "approved", "failed"])
        .select("*")
        .single();
      return mapActionJob(
        assertData(data, error, "ApprovalRepository.markJobRunning") as Record<
          string,
          unknown
        >,
      );
    },

    /**
     * Adapter failure: status=failed, error=message, target_ref.retry_count++
     * Optional errorCode stored in target_ref.error_code.
     */
    async markJobFailed(
      jobId: string,
      errorMessage: string,
      opts?: { errorCode?: string },
    ): Promise<ActionJob> {
      const job = await this.getActionJob(jobId);
      if (job.status === "permanently_failed") {
        return job;
      }
      const prev = Number(job.target_ref?.retry_count ?? 0);
      const retry_count = Number.isFinite(prev) ? prev + 1 : 1;
      const target_ref: Record<string, unknown> = {
        ...job.target_ref,
        retry_count,
        last_failed_at: new Date().toISOString(),
      };
      if (opts?.errorCode) {
        target_ref.error_code = opts.errorCode;
      }
      const { data, error } = await db
        .from("action_jobs")
        .update({
          status: "failed",
          error: errorMessage,
          target_ref,
        })
        .eq("id", jobId)
        .select("*")
        .single();
      return mapActionJob(
        assertData(data, error, "ApprovalRepository.markJobFailed") as Record<
          string,
          unknown
        >,
      );
    },

    /** retry exhausted → permanently_failed */
    async markJobPermanentlyFailed(
      jobId: string,
      errorMessage: string,
      errorCode = "retry_limit_exhausted",
    ): Promise<ActionJob> {
      const job = await this.getActionJob(jobId);
      if (job.status === "permanently_failed") return job;
      const { data, error } = await db
        .from("action_jobs")
        .update({
          status: "permanently_failed",
          error: errorMessage,
          target_ref: {
            ...job.target_ref,
            error_code: errorCode,
            permanently_failed_at: new Date().toISOString(),
          },
        })
        .eq("id", jobId)
        .in("status", ["failed", "running"])
        .select("*")
        .single();
      return mapActionJob(
        assertData(
          data,
          error,
          "ApprovalRepository.markJobPermanentlyFailed",
        ) as Record<string, unknown>,
      );
    },

    /** running jobs whose updated_at is older than cutoff ISO. */
    async listStuckRunningJobs(opts: {
      olderThanIso: string;
      limit?: number;
    }): Promise<ActionJob[]> {
      const limit = opts.limit ?? 50;
      const { data, error } = await db
        .from("action_jobs")
        .select("*")
        .eq("status", "running")
        .lt("updated_at", opts.olderThanIso)
        .order("updated_at", { ascending: true })
        .limit(limit);
      return assertData(
        data,
        error,
        "ApprovalRepository.listStuckRunningJobs",
      ).map((r) => mapActionJob(r as Record<string, unknown>));
    },

    /** Failed jobs eligible for retry (retry_count < limit). */
    async listFailedActionJobs(opts?: {
      limit?: number;
      personId?: string;
      retryLimit?: number;
    }): Promise<ActionJob[]> {
      const limit = opts?.limit ?? 50;
      let q = db
        .from("action_jobs")
        .select("*")
        .eq("status", "failed")
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (opts?.personId) q = q.eq("person_id", opts.personId);
      const { data, error } = await q;
      const rows = assertData(
        data,
        error,
        "ApprovalRepository.listFailedActionJobs",
      ).map((r) => mapActionJob(r as Record<string, unknown>));
      const retryLimit = opts?.retryLimit;
      if (retryLimit == null) return rows;
      return rows.filter((j) => {
        const n = Number(j.target_ref?.retry_count ?? 0);
        return !Number.isFinite(n) || n < retryLimit;
      });
    },

    /** Failed jobs that exceeded retry limit (candidates for permanently_failed). */
    async listExhaustedFailedJobs(opts?: {
      limit?: number;
      retryLimit: number;
    }): Promise<ActionJob[]> {
      const limit = opts?.limit ?? 50;
      const retryLimit = opts?.retryLimit ?? 3;
      const { data, error } = await db
        .from("action_jobs")
        .select("*")
        .eq("status", "failed")
        .order("updated_at", { ascending: true })
        .limit(limit * 3);
      const rows = assertData(
        data,
        error,
        "ApprovalRepository.listExhaustedFailedJobs",
      ).map((r) => mapActionJob(r as Record<string, unknown>));
      return rows
        .filter((j) => {
          const n = Number(j.target_ref?.retry_count ?? 0);
          return Number.isFinite(n) && n >= retryLimit;
        })
        .slice(0, limit);
    },

    /** Re-queue failed job for retry (status → planned) when under retry limit. */
    async requeueFailedJob(
      jobId: string,
      retryLimit: number,
    ): Promise<ActionJob> {
      const job = await this.getActionJob(jobId);
      if (job.status !== "failed") {
        throw new Error(`requeueFailedJob: status=${job.status}`);
      }
      const retries = Number(job.target_ref?.retry_count ?? 0);
      if (Number.isFinite(retries) && retries >= retryLimit) {
        throw new Error(`requeueFailedJob: retry_limit_reached (${retries})`);
      }
      const { data, error } = await db
        .from("action_jobs")
        .update({
          status: "planned",
          error: null,
          target_ref: {
            ...job.target_ref,
            requeued_at: new Date().toISOString(),
          },
        })
        .eq("id", jobId)
        .eq("status", "failed")
        .select("*")
        .single();
      return mapActionJob(
        assertData(
          data,
          error,
          "ApprovalRepository.requeueFailedJob",
        ) as Record<string, unknown>,
      );
    },

    async findRecentExecutedByPerson(
      personId: string,
      actionType: string,
      limit = 20,
    ): Promise<ActionJob[]> {
      const { data, error } = await db
        .from("action_jobs")
        .select("*")
        .eq("person_id", personId)
        .eq("action_type", actionType)
        .eq("status", "executed")
        .order("executed_at", { ascending: false })
        .limit(limit);
      return assertData(
        data,
        error,
        "ApprovalRepository.findRecentExecutedByPerson",
      ).map((r) => mapActionJob(r as Record<string, unknown>));
    },

    /**
     * Recent executed comment/like jobs for post-level duplicate checks.
     * Read-only — does not change execution flow.
     */
    async listRecentExecutedCommentLike(limit = 800): Promise<ActionJob[]> {
      const { data, error } = await db
        .from("action_jobs")
        .select("*")
        .in("action_type", ["comment", "like"])
        .eq("status", "executed")
        .order("executed_at", { ascending: false })
        .limit(Math.min(Math.max(limit, 1), 1000));
      return assertData(
        data,
        error,
        "ApprovalRepository.listRecentExecutedCommentLike",
      ).map((r) => mapActionJob(r as Record<string, unknown>));
    },

    /**
     * Recent ActionJobs for Supervisor Execution Log
     * (visit / like / comment / neighbor_request · terminal statuses).
     */
    async listRecentActionExecutions(limit = 12): Promise<ActionJob[]> {
      const { data, error } = await db
        .from("action_jobs")
        .select("*")
        .in("action_type", ["visit", "like", "comment", "neighbor_request"])
        .in("status", [
          "executed",
          "failed",
          "permanently_failed",
          "skipped_policy",
        ])
        .order("updated_at", { ascending: false })
        .limit(limit);
      return assertData(
        data,
        error,
        "ApprovalRepository.listRecentActionExecutions",
      ).map((r) => mapActionJob(r as Record<string, unknown>));
    },

    async listRecentByPerson(
      personId: string,
      limit = 20,
    ): Promise<ApprovalItem[]> {
      const { data, error } = await db
        .from("approval_items")
        .select("*")
        .eq("person_id", personId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return assertData(
        data,
        error,
        "ApprovalRepository.listRecentByPerson",
      ).map((r) => mapApproval(r as Record<string, unknown>));
    },

    async countOpenByPerson(personId: string): Promise<number> {
      const { count, error } = await db
        .from("approval_items")
        .select("*", { count: "exact", head: true })
        .eq("person_id", personId)
        .is("resolved_at", null);
      if (error)
        throw new Error(
          `ApprovalRepository.countOpenByPerson: ${error.message}`,
        );
      return count ?? 0;
    },

    async countOpenByPersonIds(
      personIds: string[],
    ): Promise<Record<string, number>> {
      const result: Record<string, number> = {};
      for (const id of personIds) result[id] = 0;
      if (personIds.length === 0) return result;

      const { data, error } = await traceQuery(
        "approval_items.count_open_by_person_ids",
        () =>
          db
            .from("approval_items")
            .select("person_id")
            .in("person_id", personIds)
            .is("resolved_at", null),
        (r) => rowCountFrom(r.data),
      );
      if (error)
        throw new Error(
          `ApprovalRepository.countOpenByPersonIds: ${error.message}`,
        );
      for (const row of data ?? []) {
        const pid = String(row.person_id);
        result[pid] = (result[pid] ?? 0) + 1;
      }
      return result;
    },
  };
}

export type ApprovalRepository = ReturnType<typeof createApprovalRepository>;
