"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  approveApprovalAction,
  checkApprovalDuplicatesAction,
  listCompletedApprovalsAction,
  listOpenApprovalsAction,
} from "@/app/actions/approvals";
import { getAgentBriefAction } from "@/app/actions/brief";
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
import {
  cleanOperatorLabel,
  isInternalDisplayText,
  operatorPostTitle,
} from "@/lib/approvalDisplay";
import { queryKeys } from "@/lib/queryKeys";
import type {
  ApprovalHistoryItem,
  ApprovalHistoryPage,
  ApprovalInboxItem,
  DuplicatePostHit,
} from "@/types/approvalInbox";

const BATCH_MODES: ApprovalExecuteMode[] = ["comment", "like", "both"];
const PAGE_SIZE = 20;

type InboxTab = "open" | "done";
type OpenFilter = "all" | "failed";

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

function itemTitle(item: ApprovalInboxItem, developerMode = false): string {
  if (developerMode) {
    return (
      item.postTitle?.trim() ||
      item.mutualRequest?.blogName ||
      item.person.display_name
    );
  }
  return operatorPostTitle(item);
}

const DEV_MODE_STORAGE_KEY = "approval-inbox-developer-mode";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEtaRange(count: number, minSec: number, maxSec: number): string {
  if (count <= 1) return "약 1분 이내";
  const gaps = count - 1;
  // rough: ~25s avg per job action + delay range
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
      return "🔴 처리실패";
    case "waiting":
      return "⏳ 대기";
    default:
      return "대기";
  }
}

export function ApprovalInboxScreen({
  items: initialOpen,
  initialCompleted,
}: {
  items: ApprovalInboxItem[];
  initialCompleted: ApprovalHistoryPage;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [openItems, setOpenItems] = useState(initialOpen);
  const [tab, setTab] = useState<InboxTab>("open");
  const [openFilter, setOpenFilter] = useState<OpenFilter>("all");
  const [openPage, setOpenPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState<ApprovalExecuteMode>("both");
  const [delayMinSec, setDelayMinSec] = useState(5);
  const [delayMaxSec, setDelayMaxSec] = useState(10);
  const [completed, setCompleted] =
    useState<ApprovalHistoryPage>(initialCompleted);
  const [completedLoading, setCompletedLoading] = useState(false);
  const [completedPreset, setCompletedPreset] =
    useState<CompletedRangePreset>("7d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIdsRef = useRef<string[]>([]);
  const pendingModeRef = useRef<ApprovalExecuteMode>("both");
  const pendingDraftsRef = useRef<Map<string, string>>(new Map());
  const uniqueIdsRef = useRef<string[]>([]);
  const lastRunSuccessRef = useRef(0);

  const delayMinMs = Math.max(0, Math.floor(delayMinSec)) * 1000;
  const delayMaxMs =
    Math.max(Math.floor(delayMinSec), Math.floor(delayMaxSec)) * 1000;

  const filteredOpen = useMemo(() => {
    if (openFilter === "failed") {
      return openItems.filter((i) => i.job.status === "failed");
    }
    return openItems;
  }, [openItems, openFilter]);

  const openTotalPages = Math.max(1, Math.ceil(filteredOpen.length / PAGE_SIZE));
  const pagedOpen = useMemo(() => {
    const page = Math.min(openPage, openTotalPages);
    const from = (page - 1) * PAGE_SIZE;
    return filteredOpen.slice(from, from + PAGE_SIZE);
  }, [filteredOpen, openPage, openTotalPages]);

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

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DEV_MODE_STORAGE_KEY);
      if (raw === "1" || raw === "true") setDeveloperMode(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DEV_MODE_STORAGE_KEY,
        developerMode ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [developerMode]);

  useEffect(() => {
    setOpenItems(initialOpen);
  }, [initialOpen]);

  useEffect(() => {
    setCompleted(initialCompleted);
  }, [initialCompleted]);

  useEffect(() => {
    setOpenPage(1);
  }, [openFilter]);

  useEffect(() => {
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    };
  }, []);

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

  async function refreshBriefCache() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.agentBrief });
    await queryClient.fetchQuery({
      queryKey: queryKeys.agentBrief,
      queryFn: () => getAgentBriefAction(),
    });
  }

  function completedQueryOptions() {
    return {
      preset: completedPreset,
      fromDate: customFrom || undefined,
      toDate: customTo || undefined,
    };
  }

  async function reloadLists() {
    const [open, done] = await Promise.all([
      listOpenApprovalsAction(),
      listCompletedApprovalsAction(1, PAGE_SIZE, completedQueryOptions()),
    ]);
    setOpenItems(open);
    setCompleted(done);
    await refreshBriefCache();
    router.refresh();
  }

  async function loadCompletedPage(
    page: number,
    opts?: {
      preset?: CompletedRangePreset;
      fromDate?: string;
      toDate?: string;
    },
  ) {
    setCompletedLoading(true);
    try {
      const next = await listCompletedApprovalsAction(page, PAGE_SIZE, {
        preset: opts?.preset ?? completedPreset,
        fromDate: opts?.fromDate ?? (customFrom || undefined),
        toDate: opts?.toDate ?? (customTo || undefined),
      });
      setCompleted(next);
    } finally {
      setCompletedLoading(false);
    }
  }

  async function changeCompletedRange(
    preset: CompletedRangePreset,
    fromDate?: string,
    toDate?: string,
  ) {
    setCompletedPreset(preset);
    if (fromDate != null) setCustomFrom(fromDate);
    if (toDate != null) setCustomTo(toDate);
    await loadCompletedPage(1, {
      preset,
      fromDate: fromDate ?? (customFrom || undefined),
      toDate: toDate ?? (customTo || undefined),
    });
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

  function goToCompletedTab() {
    setTab("done");
    setOpenFilter("all");
  }

  function closeProgressModal() {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current);
      autoCloseRef.current = null;
    }
    setProgress(null);
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
      pendingIdsRef.current = ids;
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
      console.warn("[ApprovalInbox] duplicate check failed, proceed:", err);
      showConfirmForIds(ids, mode);
    }
  }

  function requestBatchApprove() {
    void requestApprove([...selected], batchMode);
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
        const title = row ? itemTitle(row, developerMode) : id.slice(0, 8);

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

        // yield so React can paint the modal
        await sleep(30);

        const outcome = await approveApprovalAction(
          id,
          drafts.get(id),
          mode,
        );

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

      await reloadLists();

      lastRunSuccessRef.current = success;
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

      // Any successful execute → 처리완료 tab
      if (success > 0) {
        goToCompletedTab();
      }

      autoCloseRef.current = setTimeout(() => {
        setProgress(null);
        if (lastRunSuccessRef.current > 0) goToCompletedTab();
      }, 8_000);
    } finally {
      setBatchRunning(false);
      pendingIdsRef.current = [];
      pendingDraftsRef.current = new Map();
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-56 pt-6">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <Link
            href="/today"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            ← Agent Brief
          </Link>
          <button
            type="button"
            onClick={() => setDeveloperMode((v) => !v)}
            className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium ${
              developerMode
                ? "border-foreground/40 bg-secondary text-foreground"
                : "border-border/60 text-muted-foreground"
            }`}
            aria-pressed={developerMode}
            title="개발자 보기: ID·test_run_id 등 내부 정보 표시"
          >
            ⚙ 개발자 보기 {developerMode ? "ON" : "OFF"}
          </button>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Approval Inbox</h1>
        <p className="text-sm text-muted-foreground">
          {developerMode
            ? "개발자 보기 · ID / run_id / workflow 표시"
            : "승인할 댓글·공감을 확인하고 실행합니다"}
        </p>
      </header>

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
          처리완료 ({completed.total})
        </button>
      </div>

      {tab === "open" ? (
        openItems.length === 0 ? (
          <div className="rounded-xl border border-border/70 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            결재할 항목이 없습니다.
          </div>
        ) : (
          <>
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
              <div className="flex items-center gap-2">
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
                  {selectedCount}건 선택
                  {openFilter === "failed" ? " · 실패만" : ""}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {pagedOpen.map((item) => (
                <ApprovalCard
                  key={item.approval.id}
                  item={item}
                  selected={selected.has(item.approval.id)}
                  onSelectedChange={(next) =>
                    toggleOne(item.approval.id, next)
                  }
                  selectionDisabled={batchRunning}
                  developerMode={developerMode}
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
                    void (async () => {
                      const done = await listCompletedApprovalsAction(
                        1,
                        PAGE_SIZE,
                        completedQueryOptions(),
                      );
                      setCompleted(done);
                      await refreshBriefCache();
                      router.refresh();
                    })();
                  }}
                  onNeedsRefresh={() => {
                    void reloadLists();
                  }}
                />
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
          </>
        )
      ) : (
        <CompletedList
          page={completed}
          loading={completedLoading}
          developerMode={developerMode}
          preset={completedPreset}
          customFrom={customFrom}
          customTo={customTo}
          onPresetChange={(preset) => {
            void changeCompletedRange(preset);
          }}
          onCustomChange={(from, to) => {
            setCustomFrom(from);
            setCustomTo(to);
          }}
          onApplyCustom={() => {
            void changeCompletedRange("custom", customFrom, customTo);
          }}
          onPageChange={(p) => {
            void loadCompletedPage(p);
          }}
        />
      )}

      {tab === "open" && openItems.length > 0 ? (
        <div className="fixed inset-x-0 bottom-16 z-20 border-t border-border/70 bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto flex w-full max-w-lg flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">일괄 모드</span>
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

            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                실행 간격 설정
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  최소
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={delayMinSec}
                    disabled={batchRunning}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value) || 0);
                      setDelayMinSec(v);
                      if (delayMaxSec < v) setDelayMaxSec(v);
                    }}
                    className="w-14 rounded-md border border-input bg-background px-2 py-1 text-xs"
                  />
                  초
                </label>
                <span className="text-[11px] text-muted-foreground">~</span>
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  최대
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={delayMaxSec}
                    disabled={batchRunning}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value) || 0);
                      setDelayMaxSec(Math.max(delayMinSec, v));
                    }}
                    className="w-14 rounded-md border border-input bg-background px-2 py-1 text-xs"
                  />
                  초
                </label>
              </div>
            </div>

            <p className="text-center text-xs text-muted-foreground">
              선택 항목 Queue · 건 사이 {delayMinSec}~{delayMaxSec}초 랜덤
            </p>
            <Button
              className="w-full"
              disabled={batchRunning || selectedCount === 0}
              onClick={requestBatchApprove}
            >
              {batchRunning
                ? "일괄 승인 실행 중…"
                : allSelected
                  ? `전체 선택 실행 (${selectedCount})`
                  : `선택 실행 (${selectedCount})`}
            </Button>
          </div>
        </div>
      ) : null}

      {progress ? (
        <BatchFlowModal
          progress={progress}
          onCancelConfirm={closeProgressModal}
          onConfirmRun={() => {
            const ids = pendingIdsRef.current;
            if (ids.length === 0) {
              closeProgressModal();
              return;
            }
            void executeBatch(ids);
          }}
          onExcludeDuplicates={() => {
            const remaining = uniqueIdsRef.current;
            const dupIds = new Set(
              progress.duplicates.map((d) => d.approvalId),
            );
            setSelected((prev) => {
              const next = new Set(prev);
              for (const id of dupIds) next.delete(id);
              return next;
            });
            if (remaining.length === 0) {
              closeProgressModal();
              return;
            }
            showConfirmForIds(remaining, pendingModeRef.current);
          }}
          onForceRunDuplicates={() => {
            showConfirmForIds(pendingIdsRef.current, pendingModeRef.current);
          }}
          onCloseDone={() => {
            const hadSuccess = lastRunSuccessRef.current > 0;
            closeProgressModal();
            if (hadSuccess) goToCompletedTab();
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

function BatchFlowModal({
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
    progress.phase === "running" || progress.phase === "checking"
      ? onCloseDone
      : progress.phase === "done"
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
              <p className="mt-0.5 text-xs text-muted-foreground">
                마지막 처리일: {formatApprovalFailureTime(d.lastExecutedAt)}
              </p>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-col gap-2">
          <Button className="w-full" onClick={onExcludeDuplicates}>
            중복 제외 실행
            {remain > 0 ? ` (${remain})` : ""}
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
        <p className="mt-3 text-sm font-medium">실행하시겠습니까?</p>
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
            <Button variant="outline" className="w-full" onClick={onViewFailures}>
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
      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        백그라운드 처리 중 · Chrome 창이 화면에 뜨지 않습니다
      </p>
      <div className="mt-5 flex justify-end">
        <Button type="button" size="sm" variant="secondary" onClick={onCloseDone}>
          닫기
        </Button>
      </div>
    </AppModal>
  );
}

function pageNumbers(current: number, total: number): Array<number | "…"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (i > 0 && n - sorted[i - 1]! > 1) out.push("…");
    out.push(n);
  }
  return out;
}

function CompletedList({
  page,
  loading,
  developerMode,
  preset,
  customFrom,
  customTo,
  onPresetChange,
  onCustomChange,
  onApplyCustom,
  onPageChange,
}: {
  page: ApprovalHistoryPage;
  loading: boolean;
  developerMode: boolean;
  preset: CompletedRangePreset;
  customFrom: string;
  customTo: string;
  onPresetChange: (preset: CompletedRangePreset) => void;
  onCustomChange: (from: string, to: string) => void;
  onApplyCustom: () => void;
  onPageChange: (p: number) => void;
}) {
  const presets: CompletedRangePreset[] = ["today", "7d", "30d", "custom"];
  const rangeLabel = page.rangeLabel || completedRangePresetLabel(preset);
  const successCount = page.successCount ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border/70 bg-card p-4">
        <p className="text-xs font-medium text-muted-foreground">기간</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
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
        {preset === "custom" ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              시작
              <input
                type="date"
                value={customFrom}
                disabled={loading}
                onChange={(e) => onCustomChange(e.target.value, customTo)}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              종료
              <input
                type="date"
                value={customTo}
                disabled={loading}
                onChange={(e) => onCustomChange(customFrom, e.target.value)}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={loading || !customFrom || !customTo}
              onClick={onApplyCustom}
            >
              적용
            </Button>
          </div>
        ) : null}

        <div className="mt-4 rounded-lg bg-secondary/50 px-3 py-3">
          <p className="text-xs text-muted-foreground">{rangeLabel}</p>
          <p className="mt-1 text-base font-semibold tracking-tight">
            ✅ 성공 처리: {successCount}건
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-center text-xs text-muted-foreground">불러오는 중…</p>
      ) : null}

      {page.total === 0 ? (
        <div className="rounded-xl border border-border/70 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          선택한 기간에 처리 완료된 항목이 없습니다.
        </div>
      ) : (
        <>
          {page.items.map((item) => (
            <CompletedCard
              key={item.approval.id}
              item={item}
              developerMode={developerMode}
            />
          ))}
          <div className="flex flex-col items-center gap-2 pt-2">
            <p className="text-xs text-muted-foreground">처리완료</p>
            <div className="flex flex-wrap items-center justify-center gap-1">
              {pageNumbers(page.page, page.totalPages).map((n, idx) =>
                n === "…" ? (
                  <span
                    key={`ellipsis-${idx}`}
                    className="px-1 text-xs text-muted-foreground"
                  >
                    …
                  </span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    disabled={loading || n === page.page}
                    onClick={() => onPageChange(n)}
                    className={`min-w-8 rounded-md px-2 py-1 text-xs ${
                      n === page.page
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:bg-secondary"
                    }`}
                  >
                    {n}
                  </button>
                ),
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CompletedCard({
  item,
  developerMode,
}: {
  item: ApprovalHistoryItem;
  developerMode: boolean;
}) {
  const modeLabel = item.executeMode
    ? approvalModeLabel(item.executeMode)
    : item.actionLabel;
  const rawTitle = item.postTitle ?? item.person.display_name;
  const title = developerMode
    ? rawTitle
    : isInternalDisplayText(rawTitle)
      ? cleanOperatorLabel(rawTitle) || "블로그 글"
      : cleanOperatorLabel(rawTitle) || rawTitle;
  const draft =
    developerMode || !isInternalDisplayText(item.draftBody)
      ? item.draftBody
      : "";

  return (
    <article className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {modeLabel} · {item.success ? "성공" : "기타"}
          </p>
          <h2 className="mt-1 text-sm font-semibold leading-snug">{title}</h2>
          {developerMode ? (
            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
              {item.approval.id}
            </p>
          ) : null}
        </div>
        <p className="shrink-0 text-[11px] text-muted-foreground">
          {formatApprovalFailureTime(item.resolvedAt)}
        </p>
      </div>
      {draft ? (
        <blockquote className="mt-3 rounded-lg bg-secondary/70 px-3 py-2 text-sm leading-relaxed">
          {draft}
        </blockquote>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">초안 없음</p>
      )}
    </article>
  );
}
