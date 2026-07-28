"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  approveApprovalAction,
  checkApprovalDuplicatesAction,
  listNeighborFeedApprovalsAction,
  listNeighborFeedCompletedApprovalsAction,
  prepareNeighborFeedExecuteDraftAction,
  previewNeighborFeedCommentAction,
} from "@/app/actions/approvals";
import { ApprovalCard } from "@/components/approval/ApprovalCard";
import { Button } from "@/components/ui/button";
import { AppModal } from "@/components/ui/AppModal";
import {
  approvalModeLabel,
  type ApprovalExecuteMode,
} from "@/lib/approvalExecuteMode";
import { resolveBatchQueueDelayMs } from "@/lib/batchQueueDelay";
import { formatApprovalFailureTime } from "@/lib/approvalFailure";
import {
  completedRangePresetLabel,
  type CompletedRangePreset,
} from "@/lib/completedRange";
import { operatorPostTitle } from "@/lib/approvalDisplay";
import {
  isNeighborFeedDraftFresh,
  needsNeighborFeedAiDraft,
  neighborFeedDraftProbeFromInboxItem,
} from "@/lib/neighborFeedDraft";
import type {
  ApprovalHistoryPage,
  ApprovalInboxItem,
  DuplicatePostHit,
} from "@/types/approvalInbox";

const DEFAULT_PAGE_SIZE = 20;
const BATCH_MODES: ApprovalExecuteMode[] = ["comment", "like", "both"];
/** Max in-flight AI draft requests (promise queue). */
const AI_CONCURRENCY = 3;
const DEFAULT_AUTO_COUNT = 5;

type InboxTab = "open" | "done";
type OpenFilter = "all" | "failed";
type AiDraftStatus = "idle" | "waiting" | "generating" | "ready" | "failed";

type BatchProgress = {
  phase: "checking" | "duplicate" | "confirm" | "running" | "done";
  total: number;
  current: number;
  success: number;
  failed: number;
  waiting: number;
  currentTitle: string;
  modeLabel: string;
  statusKind: "idle" | "running" | "success" | "failed" | "waiting";
  nextDelaySec: number | null;
  etaLabel: string;
  duplicates: DuplicatePostHit[];
};

type AiGenProgress = {
  total: number;
  done: number;
  success: number;
  failed: number;
  inFlight: number;
  waiting: number;
  currentTitle: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEtaRange(count: number, minSec: number, maxSec: number): string {
  if (count <= 1) return "약 1분 이내";
  const gaps = count - 1;
  const perJobMin = 20;
  const perJobMax = 45;
  const minTotal = gaps * minSec + count * perJobMin;
  const maxTotal = gaps * maxSec + count * perJobMax;
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}초`;
    return r === 0 ? `${m}분` : `${m}분 ${r}초`;
  };
  return `약 ${fmt(minTotal)}~${fmt(maxTotal)}`;
}

function statusDisplay(kind: BatchProgress["statusKind"]): string {
  switch (kind) {
    case "running":
      return "🟡 처리중";
    case "success":
      return "🟢 처리완료";
    case "failed":
      return "🔴 실패";
    case "waiting":
      return "⏳ 대기";
    default:
      return "—";
  }
}

function itemTitle(item: ApprovalInboxItem): string {
  return operatorPostTitle(item);
}

export function NeighborFeedApprovalInbox({
  refreshKey = 0,
  autoCount = DEFAULT_AUTO_COUNT,
}: {
  /** Bump after collect so open list reloads. */
  refreshKey?: number;
  /** How many cards auto-draft on page entry (5|10|20). */
  autoCount?: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusApprovalId = searchParams.get("approvalId")?.trim() || null;
  const focusPersonId = searchParams.get("personId")?.trim() || null;
  const focusModeRaw = searchParams.get("mode")?.trim() || null;
  const focusMode: ApprovalExecuteMode | null =
    focusModeRaw === "like" ||
    focusModeRaw === "comment" ||
    focusModeRaw === "both"
      ? focusModeRaw
      : null;
  const focusAppliedRef = useRef<string | null>(null);
  const [focusMissHint, setFocusMissHint] = useState<string | null>(null);
  const [pinnedApprovalId, setPinnedApprovalId] = useState<string | null>(null);
  const [focusScrollId, setFocusScrollId] = useState<string | null>(null);
  const [focusReadyHint, setFocusReadyHint] = useState<string | null>(null);

  const AUTO_COUNT = [5, 10, 20].includes(autoCount)
    ? autoCount
    : DEFAULT_AUTO_COUNT;
  const PAGE_SIZE = DEFAULT_PAGE_SIZE;
  const [openItems, setOpenItems] = useState<ApprovalInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<InboxTab>("open");
  const [openFilter, setOpenFilter] = useState<OpenFilter>("all");
  const [openPage, setOpenPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState<ApprovalExecuteMode>("both");
  const [delayMinSec, setDelayMinSec] = useState(5);
  const [delayMaxSec, setDelayMaxSec] = useState(10);
  const [completed, setCompleted] = useState<ApprovalHistoryPage | null>(null);
  const [completedLoading, setCompletedLoading] = useState(false);
  const [completedPreset, setCompletedPreset] =
    useState<CompletedRangePreset>("7d");
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [aiStatus, setAiStatus] = useState<Record<string, AiDraftStatus>>({});
  const [aiErrors, setAiErrors] = useState<Record<string, string>>({});
  const [aiGenProgress, setAiGenProgress] = useState<AiGenProgress | null>(
    null,
  );
  const autoGenKeyRef = useRef<string>("");
  const aiQueueRunningRef = useRef(false);
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIdsRef = useRef<string[]>([]);
  const pendingModeRef = useRef<ApprovalExecuteMode>("both");
  const pendingDraftsRef = useRef<Map<string, string>>(new Map());
  const uniqueIdsRef = useRef<string[]>([]);
  const itemByIdRef = useRef(new Map<string, ApprovalInboxItem>());

  const delayMinMs = Math.max(0, Math.floor(delayMinSec)) * 1000;
  const delayMaxMs =
    Math.max(Math.floor(delayMinSec), Math.floor(delayMaxSec)) * 1000;

  const filteredOpen = useMemo(() => {
    let list =
      openFilter === "failed"
        ? openItems.filter((i) => i.job.status === "failed")
        : [...openItems];
    if (pinnedApprovalId) {
      const idx = list.findIndex((i) => i.approval.id === pinnedApprovalId);
      if (idx > 0) {
        const [hit] = list.splice(idx, 1);
        if (hit) list.unshift(hit);
      }
    }
    return list;
  }, [openItems, openFilter, pinnedApprovalId]);

  const openTotalPages = Math.max(1, Math.ceil(filteredOpen.length / PAGE_SIZE));
  const pagedOpen = useMemo(() => {
    const page = Math.min(openPage, openTotalPages);
    const from = (page - 1) * PAGE_SIZE;
    return filteredOpen.slice(from, from + PAGE_SIZE);
  }, [filteredOpen, openPage, openTotalPages, PAGE_SIZE]);

  const allIds = useMemo(
    () => filteredOpen.map((i) => i.approval.id),
    [filteredOpen],
  );
  const selectedCount = selected.size;
  const allSelected = allIds.length > 0 && selectedCount === allIds.length;

  const itemById = useMemo(() => {
    const map = new Map<string, ApprovalInboxItem>();
    for (const it of openItems) map.set(it.approval.id, it);
    return map;
  }, [openItems]);
  itemByIdRef.current = itemById;

  async function reloadOpen() {
    setLoading(true);
    try {
      const open = await listNeighborFeedApprovalsAction();
      setOpenItems(open);
    } finally {
      setLoading(false);
    }
  }

  async function reloadCompleted(page = 1, preset?: CompletedRangePreset) {
    setCompletedLoading(true);
    try {
      const done = await listNeighborFeedCompletedApprovalsAction(
        page,
        PAGE_SIZE,
        { preset: preset ?? completedPreset },
      );
      setCompleted(done);
    } finally {
      setCompletedLoading(false);
    }
  }

  useEffect(() => {
    autoGenKeyRef.current = "";
    void reloadOpen();
  }, [refreshKey]);

  /** Deep link: ?tab=feed&approvalId=… or &personId=… → pin, select, scroll. */
  useEffect(() => {
    if (loading) return;
    const focusKey = focusApprovalId
      ? `a:${focusApprovalId}:${focusMode ?? ""}`
      : focusPersonId
        ? `p:${focusPersonId}:${focusMode ?? ""}`
        : null;
    if (!focusKey) {
      setFocusMissHint(null);
      setFocusReadyHint(null);
      return;
    }
    if (focusAppliedRef.current === focusKey) return;

    const byApproval = focusApprovalId
      ? openItems.find((i) => i.approval.id === focusApprovalId)
      : null;
    const byPerson = focusPersonId
      ? openItems.find((i) => i.person.id === focusPersonId)
      : null;
    const target = byApproval ?? byPerson ?? null;

    if (!target) {
      focusAppliedRef.current = focusKey;
      setPinnedApprovalId(null);
      setFocusScrollId(null);
      setFocusReadyHint(null);
      setFocusMissHint(
        "해당 이웃의 대기 중인 새글 승인이 없습니다. 아래에서 새글을 수집한 뒤 처리하세요.",
      );
      setTab("open");
      return;
    }

    focusAppliedRef.current = focusKey;
    setFocusMissHint(null);
    setFocusReadyHint(
      "오늘 돌볼 이웃에서 이동했습니다. 아래에서 바로 승인할 수 있습니다.",
    );
    setTab("open");
    setOpenFilter("all");
    setPinnedApprovalId(target.approval.id);
    setOpenPage(1);
    setSelected(new Set([target.approval.id]));
    setFocusScrollId(target.approval.id);
    if (focusMode) setBatchMode(focusMode);
  }, [loading, openItems, focusApprovalId, focusPersonId, focusMode]);

  /** Scroll after pin/page state is painted so the card is in the DOM. */
  useEffect(() => {
    if (!focusScrollId || loading) return;
    const onPage = pagedOpen.some((i) => i.approval.id === focusScrollId);
    if (!onPage) return;

    const timer = window.setTimeout(() => {
      const el = document.querySelector(
        `[data-feed-approval-id="${focusScrollId}"]`,
      );
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const focusable = el.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      focusable?.focus({ preventScroll: true });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [focusScrollId, loading, openPage, pagedOpen]);

  useEffect(() => {
    if (tab === "done" && !completed) {
      void reloadCompleted(1);
    }
  }, [tab, completed]);

  function idsNeedingAi(items: ApprovalInboxItem[]): string[] {
    return items
      .filter((item) => {
        if (item.job.action_type !== "comment") return false;
        if (item.job.status === "failed") return false;
        const probe = neighborFeedDraftProbeFromInboxItem(item);
        if (isNeighborFeedDraftFresh(probe)) return false;
        return needsNeighborFeedAiDraft(probe);
      })
      .map((i) => i.approval.id);
  }

  function applyReadyDraft(
    approvalId: string,
    body: string,
    generatedAt?: string,
  ) {
    setOpenItems((prev) =>
      prev.map((x) => {
        if (x.approval.id !== approvalId) return x;
        const at = generatedAt ?? new Date().toISOString();
        return {
          ...x,
          draftBody: body,
          approval: {
            ...x.approval,
            presented_context: {
              ...(x.approval.presented_context ?? {}),
              ai_draft_generated_at: at,
              ai_generated_at: at,
              ai_comment: body,
              ai_draft_source: "neighbor_feed_llm",
            },
          },
          job: {
            ...x.job,
            target_ref: {
              ...(x.job.target_ref ?? {}),
              ai_draft_generated_at: at,
              ai_generated_at: at,
              ai_comment: body,
              ai_draft_source: "neighbor_feed_llm",
            },
          },
        };
      }),
    );
    setAiStatus((prev) => ({ ...prev, [approvalId]: "ready" }));
    setAiErrors((prev) => {
      const next = { ...prev };
      delete next[approvalId];
      return next;
    });
  }

  /**
   * Promise queue: max AI_CONCURRENCY in flight.
   * Each completion updates its card immediately — no wait for the full batch.
   */
  async function generateAiForPageIds(
    ids: string[],
    opts?: { showBanner?: boolean },
  ) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    if (aiQueueRunningRef.current) {
      // Append is complex; skip overlapping auto-runs
    }
    aiQueueRunningRef.current = true;

    setAiStatus((prev) => {
      const next = { ...prev };
      for (const id of unique) {
        if (next[id] !== "generating" && next[id] !== "ready") {
          next[id] = "waiting";
        }
      }
      return next;
    });
    setAiErrors((prev) => {
      const next = { ...prev };
      for (const id of unique) delete next[id];
      return next;
    });

    let success = 0;
    let failed = 0;
    let done = 0;
    let cursor = 0;
    let inFlight = 0;
    const activeTitles = new Map<string, string>();

    const publishBanner = () => {
      if (!opts?.showBanner) return;
      const currentTitle =
        [...activeTitles.values()][0] ??
        (done < unique.length ? "대기 중…" : "완료");
      setAiGenProgress({
        total: unique.length,
        done,
        success,
        failed,
        inFlight,
        waiting: Math.max(0, unique.length - done - inFlight),
        currentTitle,
      });
    };

    if (opts?.showBanner) {
      setAiGenProgress({
        total: unique.length,
        done: 0,
        success: 0,
        failed: 0,
        inFlight: 0,
        waiting: unique.length,
        currentTitle: "시작…",
      });
    }

    await new Promise<void>((resolve) => {
      const launchNext = () => {
        while (inFlight < AI_CONCURRENCY && cursor < unique.length) {
          const id = unique[cursor]!;
          cursor += 1;
          inFlight += 1;
          const title = itemByIdRef.current.get(id)
            ? itemTitle(itemByIdRef.current.get(id)!)
            : id.slice(0, 8);
          activeTitles.set(id, title);
          setAiStatus((prev) => ({ ...prev, [id]: "generating" }));
          publishBanner();

          void previewNeighborFeedCommentAction(id)
            .then((result) => {
              if (result.success) {
                success += 1;
                applyReadyDraft(id, result.body, result.generatedAt);
              } else {
                failed += 1;
                setAiStatus((prev) => ({ ...prev, [id]: "failed" }));
                setAiErrors((prev) => ({
                  ...prev,
                  [id]: result.message,
                }));
              }
            })
            .catch((err) => {
              failed += 1;
              setAiStatus((prev) => ({ ...prev, [id]: "failed" }));
              setAiErrors((prev) => ({
                ...prev,
                [id]:
                  err instanceof Error
                    ? err.message
                    : "AI 댓글 생성에 실패했습니다.",
              }));
            })
            .finally(() => {
              activeTitles.delete(id);
              inFlight -= 1;
              done += 1;
              publishBanner();
              if (done >= unique.length) {
                resolve();
              } else {
                launchNext();
              }
            });
        }
      };

      if (unique.length === 0) resolve();
      else launchNext();
    });

    aiQueueRunningRef.current = false;
    if (opts?.showBanner) {
      setAiGenProgress({
        total: unique.length,
        done: unique.length,
        success,
        failed,
        inFlight: 0,
        waiting: 0,
        currentTitle: "완료",
      });
      await sleep(800);
      setAiGenProgress(null);
    }
  }

  // Auto-generate only the first AUTO_COUNT needing drafts on this page
  useEffect(() => {
    if (tab !== "open" || loading || batchRunning) return;
    if (pagedOpen.length === 0) return;
    const key = `${openPage}:${AUTO_COUNT}:${pagedOpen.map((i) => i.approval.id).join(",")}`;
    if (autoGenKeyRef.current === key) return;
    autoGenKeyRef.current = key;

    const need = idsNeedingAi(pagedOpen);
    setAiStatus((prev) => {
      const next = { ...prev };
      for (const item of pagedOpen) {
        const probe = neighborFeedDraftProbeFromInboxItem(item);
        if (isNeighborFeedDraftFresh(probe) || !needsNeighborFeedAiDraft(probe)) {
          next[item.approval.id] = "ready";
        } else if (!next[item.approval.id]) {
          next[item.approval.id] = "idle";
        }
      }
      return next;
    });
    const autoIds = need.slice(0, AUTO_COUNT);
    if (autoIds.length === 0) return;
    void generateAiForPageIds(autoIds, { showBanner: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- page window only
  }, [tab, loading, batchRunning, openPage, AUTO_COUNT, pagedOpen]);

  function toggleOne(id: string, next: boolean) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }

  function closeProgressModal() {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current);
      autoCloseRef.current = null;
    }
    setProgress(null);
  }

  function goToCompletedTab() {
    setTab("done");
    setOpenFilter("all");
    void reloadCompleted(1);
  }

  async function waitWithCountdown(delayMs: number) {
    const end = Date.now() + delayMs;
    while (Date.now() < end) {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              nextDelaySec: left,
              statusKind: "waiting",
            }
          : prev,
      );
      await sleep(Math.min(200, Math.max(0, end - Date.now())));
    }
    setProgress((prev) =>
      prev ? { ...prev, nextDelaySec: null } : prev,
    );
  }

  function showConfirmForIds(ids: string[], mode: ApprovalExecuteMode) {
    if (ids.length === 0) {
      closeProgressModal();
      return;
    }
    pendingIdsRef.current = ids;
    pendingModeRef.current = mode;
    setProgress({
      phase: "confirm",
      total: ids.length,
      current: 0,
      success: 0,
      failed: 0,
      waiting: ids.length,
      currentTitle: "-",
      modeLabel: approvalModeLabel(mode),
      statusKind: "idle",
      nextDelaySec: null,
      etaLabel: formatEtaRange(ids.length, delayMinSec, delayMaxSec),
      duplicates: [],
    });
  }

  async function requestApprove(
    ids: string[],
    mode: ApprovalExecuteMode,
    drafts?: Map<string, string>,
  ) {
    if (ids.length === 0 || batchRunning) return;
    pendingIdsRef.current = ids;
    pendingModeRef.current = mode;
    pendingDraftsRef.current = drafts ?? new Map();

    setProgress({
      phase: "checking",
      total: ids.length,
      current: 0,
      success: 0,
      failed: 0,
      waiting: ids.length,
      currentTitle: "-",
      modeLabel: approvalModeLabel(mode),
      statusKind: "idle",
      nextDelaySec: null,
      etaLabel: formatEtaRange(ids.length, delayMinSec, delayMaxSec),
      duplicates: [],
    });

    try {
      const check = await checkApprovalDuplicatesAction(ids);
      if (check.duplicates.length === 0) {
        showConfirmForIds(ids, mode);
        return;
      }
      uniqueIdsRef.current = check.uniqueApprovalIds;
      setProgress({
        phase: "duplicate",
        total: ids.length,
        current: 0,
        success: 0,
        failed: 0,
        waiting: ids.length,
        currentTitle: "-",
        modeLabel: approvalModeLabel(mode),
        statusKind: "idle",
        nextDelaySec: null,
        etaLabel: formatEtaRange(ids.length, delayMinSec, delayMaxSec),
        duplicates: check.duplicates,
      });
    } catch (err) {
      console.warn("[NeighborFeedInbox] duplicate check failed:", err);
      showConfirmForIds(ids, mode);
    }
  }

  async function executeBatch(ids: string[]) {
    setBatchRunning(true);
    let success = 0;
    let failed = 0;
    const total = ids.length;
    const mode = pendingModeRef.current;
    const drafts = pendingDraftsRef.current;
    const modeLabel = approvalModeLabel(mode);

    setProgress({
      phase: "running",
      total,
      current: 0,
      success: 0,
      failed: 0,
      waiting: total,
      currentTitle: "-",
      modeLabel,
      statusKind: "idle",
      nextDelaySec: null,
      etaLabel: "",
      duplicates: [],
    });

    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const row = itemById.get(id);
        const title = row ? itemTitle(row) : id.slice(0, 8);

        setProgress({
          phase: "running",
          total,
          current: i + 1,
          success,
          failed,
          waiting: Math.max(0, total - (i + 1)),
          currentTitle: title,
          modeLabel,
          statusKind: "running",
          nextDelaySec: null,
          etaLabel: "",
          duplicates: [],
        });
        await sleep(30);

        let draftBody = drafts.get(id);
        if (row && (mode === "comment" || mode === "both")) {
          const userProvided =
            draftBody != null &&
            draftBody.trim().length > 0 &&
            drafts.has(id);
          if (!userProvided) {
            try {
              // Reuse fresh preview; regenerate if missing/stale (uses stored post title/summary)
              draftBody = await prepareNeighborFeedExecuteDraftAction(id, {
                forceFresh: !isNeighborFeedDraftFresh(
                  neighborFeedDraftProbeFromInboxItem(row),
                ),
              });
              setOpenItems((prev) =>
                prev.map((x) =>
                  x.approval.id === id
                    ? { ...x, draftBody: draftBody ?? x.draftBody }
                    : x,
                ),
              );
            } catch (err) {
              failed += 1;
              const errMsg =
                err instanceof Error
                  ? err.message
                  : "AI 댓글 생성에 실패했습니다.";
              setProgress({
                phase: "running",
                total,
                current: i + 1,
                success,
                failed,
                waiting: Math.max(0, total - (i + 1)),
                currentTitle: `${title} · ${errMsg}`,
                modeLabel,
                statusKind: "failed",
                nextDelaySec: null,
                etaLabel: "",
                duplicates: [],
              });
              await sleep(40);
              if (i < ids.length - 1) {
                const delayMs = resolveBatchQueueDelayMs({
                  minMs: delayMinMs,
                  maxMs: delayMaxMs,
                });
                await waitWithCountdown(delayMs);
              }
              continue;
            }
          }
        }

        const outcome = await approveApprovalAction(id, draftBody, mode);

        if (outcome.ok) {
          success += 1;
          setOpenItems((prev) => prev.filter((x) => x.approval.id !== id));
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          setProgress({
            phase: "running",
            total,
            current: i + 1,
            success,
            failed,
            waiting: Math.max(0, total - (i + 1)),
            currentTitle: title,
            modeLabel,
            statusKind: "success",
            nextDelaySec: null,
            etaLabel: "",
            duplicates: [],
          });
        } else {
          failed += 1;
          setProgress({
            phase: "running",
            total,
            current: i + 1,
            success,
            failed,
            waiting: Math.max(0, total - (i + 1)),
            currentTitle: title,
            modeLabel,
            statusKind: "failed",
            nextDelaySec: null,
            etaLabel: "",
            duplicates: [],
          });
        }

        await sleep(40);
        if (i < ids.length - 1) {
          const delayMs = resolveBatchQueueDelayMs({
            minMs: delayMinMs,
            maxMs: delayMaxMs,
          });
          await waitWithCountdown(delayMs);
        }
      }

      await reloadOpen();
      setCompleted(null);

      setProgress({
        phase: "done",
        total,
        current: total,
        success,
        failed,
        waiting: 0,
        currentTitle: "-",
        modeLabel,
        statusKind: success > 0 ? "success" : failed > 0 ? "failed" : "idle",
        nextDelaySec: null,
        etaLabel: "",
        duplicates: [],
      });

      if (success > 0) {
        goToCompletedTab();
      }
      router.refresh();
    } finally {
      setBatchRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 rounded-xl border border-border/70 bg-secondary/40 p-1">
        <button
          type="button"
          onClick={() => {
            setTab("open");
            setOpenFilter("all");
          }}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${
            tab === "open"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground"
          }`}
        >
          미처리 ({openItems.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("done")}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${
            tab === "done"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground"
          }`}
        >
          처리완료 ({completed?.total ?? "…"})
        </button>
      </div>

      {tab === "open" ? (
        loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            불러오는 중…
          </p>
        ) : openItems.length === 0 ? (
          <div className="space-y-3">
            {focusMissHint ? (
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                {focusMissHint}
              </p>
            ) : null}
            <div className="rounded-xl border border-border/70 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
              수집된 이웃 새글이 없습니다. 위에서 새글 수집을 실행해 주세요.
            </div>
          </div>
        ) : (
          <>
            {focusMissHint ? (
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                {focusMissHint}
              </p>
            ) : null}
            {focusReadyHint && !focusMissHint ? (
              <p className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-foreground">
                {focusReadyHint}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 rounded border-border"
                  checked={allSelected}
                  disabled={batchRunning}
                  onChange={toggleAll}
                />
                전체 선택
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    batchRunning ||
                    Boolean(aiGenProgress) ||
                    pagedOpen.length === 0
                  }
                  onClick={() => {
                    const need = idsNeedingAi(pagedOpen);
                    const ids =
                      need.length > 0
                        ? need
                        : pagedOpen
                            .filter((i) => i.job.action_type === "comment")
                            .map((i) => i.approval.id);
                    void generateAiForPageIds(ids, { showBanner: true });
                  }}
                >
                  댓글 초안 전체 생성
                </Button>
                {openFilter === "failed" ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => setOpenFilter("all")}
                  >
                    전체 보기
                  </button>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {selectedCount}건 선택 · 자동 {AUTO_COUNT}건 · {PAGE_SIZE}
                  건/페이지
                </span>
              </div>
            </div>

            {aiGenProgress ? (
              <div className="rounded-xl border border-border/70 bg-secondary/40 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold">AI 댓글 생성</p>
                  <p className="text-muted-foreground">
                    {aiGenProgress.done} / {aiGenProgress.total} 완료
                  </p>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  현재:{" "}
                  <span className="font-medium text-foreground">
                    {aiGenProgress.currentTitle}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  🟢 {aiGenProgress.success}건 · 🟡 진행중{" "}
                  {aiGenProgress.inFlight}건 · ⚪ 대기 {aiGenProgress.waiting}
                  건
                  {aiGenProgress.failed > 0
                    ? ` · 🔴 실패 ${aiGenProgress.failed}건`
                    : ""}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  완료된 카드는 바로 선택·실행할 수 있습니다.
                </p>
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              {pagedOpen.map((item) => (
                <div
                  key={item.approval.id}
                  data-feed-approval-id={item.approval.id}
                  className={
                    selected.has(item.approval.id)
                      ? "rounded-xl ring-2 ring-primary/40"
                      : undefined
                  }
                >
                  <ApprovalCard
                    item={item}
                    selected={selected.has(item.approval.id)}
                    preferredMode={
                      pinnedApprovalId === item.approval.id
                        ? focusMode ?? undefined
                        : undefined
                    }
                    onSelectedChange={(next) =>
                      toggleOne(item.approval.id, next)
                    }
                    selectionDisabled={batchRunning}
                    neighborAiStatus={(() => {
                      const s = aiStatus[item.approval.id];
                      if (
                        s === "generating" ||
                        s === "ready" ||
                        s === "failed"
                      ) {
                        return s;
                      }
                      if (
                        needsNeighborFeedAiDraft(
                          neighborFeedDraftProbeFromInboxItem(item),
                        )
                      ) {
                        return "idle";
                      }
                      return "ready";
                    })()}
                    neighborAiError={aiErrors[item.approval.id] ?? null}
                    onNeighborDraftBodyChange={(body) => {
                      setOpenItems((prev) =>
                        prev.map((x) =>
                          x.approval.id === item.approval.id
                            ? { ...x, draftBody: body }
                            : x,
                        ),
                      );
                      setAiStatus((prev) => ({
                        ...prev,
                        [item.approval.id]: "ready",
                      }));
                    }}
                    onNeighborAiGenerate={() => {
                      void generateAiForPageIds([item.approval.id], {
                        showBanner: false,
                      });
                    }}
                    onRequestApprove={({ approvalId, draftBody, mode }) => {
                      const drafts = new Map<string, string>();
                      if (draftBody != null) drafts.set(approvalId, draftBody);
                      void requestApprove(
                        [approvalId],
                        mode ?? batchMode,
                        drafts,
                      );
                    }}
                    onResolved={(id) => {
                      setOpenItems((prev) =>
                        prev.filter((x) => x.approval.id !== id),
                      );
                      setSelected((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                      });
                      goToCompletedTab();
                      router.refresh();
                    }}
                    onNeedsRefresh={() => {
                      void reloadOpen().then(() => {
                        autoGenKeyRef.current = "";
                      });
                    }}
                  />
                </div>
              ))}
            </div>

            {filteredOpen.length > PAGE_SIZE ? (
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  variant="outline"
                  disabled={openPage <= 1 || batchRunning}
                  onClick={() => setOpenPage((p) => Math.max(1, p - 1))}
                >
                  이전
                </Button>
                <p className="text-xs text-muted-foreground">
                  {Math.min(openPage, openTotalPages)} / {openTotalPages}
                </p>
                <Button
                  variant="outline"
                  disabled={openPage >= openTotalPages || batchRunning}
                  onClick={() =>
                    setOpenPage((p) => Math.min(openTotalPages, p + 1))
                  }
                >
                  다음
                </Button>
              </div>
            ) : null}

            <div className="sticky bottom-16 z-20 rounded-xl border border-border/70 bg-background/95 p-3 shadow-sm backdrop-blur">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  실행 모드
                </span>
                {BATCH_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={batchRunning}
                    onClick={() => setBatchMode(m)}
                    className={`rounded-md border px-2 py-1 text-[11px] ${
                      batchMode === m
                        ? "border-foreground/50 bg-secondary"
                        : "border-border/60 text-muted-foreground"
                    }`}
                  >
                    {approvalModeLabel(m)}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  간격
                  <input
                    type="number"
                    min={0}
                    value={delayMinSec}
                    disabled={batchRunning}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value) || 0);
                      setDelayMinSec(v);
                      if (delayMaxSec < v) setDelayMaxSec(v);
                    }}
                    className="w-12 rounded-md border border-input bg-background px-1.5 py-1 text-xs"
                  />
                  ~
                  <input
                    type="number"
                    min={0}
                    value={delayMaxSec}
                    disabled={batchRunning}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value) || 0);
                      setDelayMaxSec(Math.max(delayMinSec, v));
                    }}
                    className="w-12 rounded-md border border-input bg-background px-1.5 py-1 text-xs"
                  />
                  초
                </label>
              </div>
              <Button
                className="mt-2.5 w-full"
                disabled={selectedCount === 0 || batchRunning}
                onClick={() => void requestApprove([...selected], batchMode)}
              >
                선택 {selectedCount}건 실행
              </Button>
            </div>
          </>
        )
      ) : (
        <NeighborFeedCompletedList
          page={completed}
          loading={completedLoading}
          preset={completedPreset}
          onPresetChange={(p) => {
            setCompletedPreset(p);
            void reloadCompleted(1, p);
          }}
          onPageChange={(p) => void reloadCompleted(p)}
        />
      )}

      {progress ? (
        <FeedBatchModal
          progress={progress}
          onCancelConfirm={closeProgressModal}
          onConfirmRun={() => {
            void executeBatch([...pendingIdsRef.current]);
          }}
          onExcludeDuplicates={() => {
            const ids = uniqueIdsRef.current;
            if (ids.length === 0) {
              closeProgressModal();
              return;
            }
            showConfirmForIds(ids, pendingModeRef.current);
          }}
          onForceRunDuplicates={() => {
            showConfirmForIds(
              [...pendingIdsRef.current],
              pendingModeRef.current,
            );
          }}
          onCloseDone={() => {
            closeProgressModal();
            if (openItems.length === 0 || progress.success > 0) {
              goToCompletedTab();
            }
          }}
          onViewFailures={() => {
            closeProgressModal();
            setTab("open");
            setOpenFilter("failed");
            setOpenPage(1);
          }}
        />
      ) : null}
    </div>
  );
}

function NeighborFeedCompletedList({
  page,
  loading,
  preset,
  onPresetChange,
  onPageChange,
}: {
  page: ApprovalHistoryPage | null;
  loading: boolean;
  preset: CompletedRangePreset;
  onPresetChange: (preset: CompletedRangePreset) => void;
  onPageChange: (p: number) => void;
}) {
  const presets: CompletedRangePreset[] = ["today", "7d", "30d"];
  if (!page && loading) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  }
  if (!page) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        처리완료 내역이 없습니다.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            disabled={loading}
            onClick={() => onPresetChange(p)}
            className={`rounded-md border px-2.5 py-1.5 text-xs ${
              preset === p
                ? "border-foreground/50 bg-secondary font-medium"
                : "border-border/60 text-muted-foreground"
            }`}
          >
            {completedRangePresetLabel(p)}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {page.rangeLabel} · 성공 {page.successCount}건 · 전체 {page.total}건
      </p>
      {page.items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          처리완료된 이웃 새글이 없습니다.
        </p>
      ) : (
        page.items.map((item) => (
          <article
            key={item.approval.id}
            className="rounded-xl border border-border/70 bg-card p-4"
          >
            <p className="text-[11px] font-medium text-muted-foreground">
              [이웃 새글]
            </p>
            <h3 className="mt-0.5 text-sm font-semibold leading-snug">
              {item.postTitle?.trim() || "블로그 글"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {item.person.display_name}
              {" · "}
              {item.executeMode
                ? approvalModeLabel(item.executeMode)
                : item.actionLabel}
              {" · "}
              {item.success ? "성공" : "실패"}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatApprovalFailureTime(item.resolvedAt)}
            </p>
          </article>
        ))
      )}
      {page.totalPages > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            disabled={page.page <= 1 || loading}
            onClick={() => onPageChange(page.page - 1)}
          >
            이전
          </Button>
          <p className="text-xs text-muted-foreground">
            {page.page} / {page.totalPages}
          </p>
          <Button
            variant="outline"
            disabled={page.page >= page.totalPages || loading}
            onClick={() => onPageChange(page.page + 1)}
          >
            다음
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FeedBatchModal({
  progress,
  onCancelConfirm,
  onConfirmRun,
  onExcludeDuplicates,
  onForceRunDuplicates,
  onCloseDone,
  onViewFailures,
}: {
  progress: BatchProgress;
  onCancelConfirm: () => void;
  onConfirmRun: () => void;
  onExcludeDuplicates: () => void;
  onForceRunDuplicates: () => void;
  onCloseDone: () => void;
  onViewFailures: () => void;
}) {
  const close =
    progress.phase === "done" ||
    progress.phase === "running" ||
    progress.phase === "checking"
      ? onCloseDone
      : onCancelConfirm;

  if (progress.phase === "checking") {
    return (
      <AppModal open title="중복 확인 중" onClose={close} footer={null}>
        <p className="text-sm text-muted-foreground">
          이미 처리한 포스팅이 있는지 확인하고 있습니다…
        </p>
        <div className="mt-5 flex justify-end">
          <Button type="button" size="sm" variant="secondary" onClick={close}>
            닫기
          </Button>
        </div>
      </AppModal>
    );
  }

  if (progress.phase === "duplicate") {
    const dupCount = progress.duplicates.length;
    const remain = Math.max(0, progress.total - dupCount);
    return (
      <AppModal
        open
        title="이미 처리한 포스팅이 있습니다."
        onClose={onCancelConfirm}
        footer={null}
      >
        <p className="text-xs text-muted-foreground">
          중복 {dupCount}건 · 신규 {remain}건
        </p>
        <ul className="mt-4 max-h-56 space-y-3 overflow-y-auto">
          {progress.duplicates.map((d) => (
            <li
              key={d.approvalId}
              className="rounded-lg bg-secondary/60 px-3 py-2.5 text-sm"
            >
              <p className="font-medium leading-snug">{d.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                처리 종류: {approvalModeLabel(d.priorMode)}
              </p>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-col gap-2">
          <Button className="w-full" onClick={onExcludeDuplicates}>
            중복 제외 실행{remain > 0 ? ` (${remain})` : ""}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={onForceRunDuplicates}
          >
            그래도 실행 ({progress.total})
          </Button>
          <Button variant="ghost" className="w-full" onClick={onCancelConfirm}>
            취소
          </Button>
        </div>
      </AppModal>
    );
  }

  if (progress.phase === "confirm") {
    return (
      <AppModal open title="실행 확인" onClose={onCancelConfirm} footer={null}>
        <p className="text-sm">선택한 {progress.total}건을 실행합니다.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          모드: {progress.modeLabel}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          예상 소요시간: {progress.etaLabel}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          템플릿 댓글은 실행 직전 이웃 새글 전용 AI로 생성됩니다.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onCancelConfirm}>
            취소
          </Button>
          <Button onClick={onConfirmRun}>실행</Button>
        </div>
      </AppModal>
    );
  }

  if (progress.phase === "done") {
    return (
      <AppModal
        open
        title="처리 완료되었습니다."
        onClose={onCloseDone}
        footer={null}
      >
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">총 처리</dt>
            <dd className="font-medium">{progress.total}건</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">성공</dt>
            <dd className="font-medium">{progress.success}건</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">실패</dt>
            <dd className="font-medium">{progress.failed}건</dd>
          </div>
        </dl>
        <div className="mt-5 flex flex-col gap-2">
          {progress.failed > 0 ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={onViewFailures}
            >
              실패 건 보기
            </Button>
          ) : null}
          <Button className="w-full" onClick={onCloseDone}>
            닫기
          </Button>
        </div>
      </AppModal>
    );
  }

  return (
    <AppModal
      open
      title="자동 처리 진행 중"
      onClose={onCloseDone}
      footer={null}
    >
      <dl className="space-y-2.5 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">전체</dt>
          <dd className="font-medium">{progress.total}건</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">현재 처리</dt>
          <dd className="font-medium">
            {progress.current} / {progress.total}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">성공</dt>
          <dd>{progress.success}건</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">실패</dt>
          <dd>{progress.failed}건</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">대기</dt>
          <dd>{progress.waiting}건</dd>
        </div>
        <div className="rounded-lg bg-secondary/60 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">현재</p>
          <p className="mt-1 text-sm font-medium leading-snug">
            {progress.currentTitle}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            처리 유형: {progress.modeLabel}
          </p>
          <p className="mt-1 text-sm">
            상태: {statusDisplay(progress.statusKind)}
          </p>
        </div>
        {progress.nextDelaySec != null ? (
          <p className="text-center text-sm text-muted-foreground">
            다음 작업까지 약 {progress.nextDelaySec}초
          </p>
        ) : null}
      </dl>
      <div className="mt-5 flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onCloseDone}
        >
          닫기
        </Button>
      </div>
    </AppModal>
  );
}
