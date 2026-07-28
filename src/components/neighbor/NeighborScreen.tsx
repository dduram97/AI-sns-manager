"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  allowNeighborBlogAgainAction,
  analyzeNeighborAiBatchAction,
  checkNeighborDuplicatesAction,
  checkPendingNeighborStatusesAction,
  createNeighborRequestApprovalAction,
  excludeNeighborBlogAction,
  filterNeighborCandidatesAction,
  finalizeNeighborCollectAction,
  getNeighborScreenAction,
  listNeighborCandidatesAction,
  listNeighborCompletedAction,
  listNeighborExclusionsAction,
  markNeighborRequestedAction,
  markNeighborRequestFailedAction,
  searchNeighborCandidatesAction,
  updateNeighborSettingsAction,
} from "@/app/actions/neighbors";
import { approveApprovalAction } from "@/app/actions/approvals";
import { Button } from "@/components/ui/button";
import { AppModal } from "@/components/ui/AppModal";
import {
  formatApprovalFailureTime,
  toFriendlyFailure,
} from "@/lib/approvalFailure";
import { resolveBatchQueueDelayMs } from "@/lib/batchQueueDelay";
import {
  completedRangePresetLabel,
  type CompletedRangePreset,
} from "@/lib/completedRange";
import {
  neighborRelationStatusLabel,
  statusCheckModeLabel,
  type NeighborStatusCheckMode,
} from "@/domain/neighbor/relationStatus";
import { NeighborFeedPanel } from "@/components/neighbor/NeighborFeedPanel";
import { NeighborManagePanel } from "@/components/neighbor/NeighborManagePanel";
import { NeighborCandidateCard } from "@/components/neighbor/NeighborCandidateCard";
import { NeighborCandidatesSummary } from "@/components/neighbor/NeighborCandidatesSummary";
import type { NeighborPipelineFunnel } from "@/services/neighborPipelineFunnel";
import {
  toNeighborAiRowInput,
} from "@/lib/neighborAiDisplay";
import type {
  NeighborCandidate,
  NeighborCompletedPage,
  NeighborCompletedStatusFilter,
  NeighborExclusion,
  NeighborSettingsView,
} from "@/types/neighborScreen";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useNeighborPageOptional,
  type NeighborTab,
} from "@/components/neighbor/NeighborPageContext";
import { NeighborQuotaHintSync } from "@/components/neighbor/NeighborPageHeaderClient";

type Tab = NeighborTab;

const PAGE_SIZE = 15;
const INITIAL_VISIBLE_CANDIDATES = 30;
const CANDIDATES_LOAD_MORE_STEP = 20;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatEta(count: number, minSec: number, maxSec: number): string {
  if (count <= 0) return "-";
  if (count === 1) {
    const lo = Math.max(5, minSec);
    const hi = Math.max(lo, maxSec);
    return `약 ${lo}~${hi}초`;
  }
  const gaps = count - 1;
  const min = gaps * minSec + count * 25;
  const max = gaps * maxSec + count * 50;
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}초`;
    return r === 0 ? `${m}분` : `${m}분 ${r}초`;
  };
  return `약 ${fmt(min)}~${fmt(max)}`;
}

function statusDisplay(
  kind: "idle" | "running" | "success" | "failed" | "waiting",
): string {
  switch (kind) {
    case "running":
      return "🟡 신청 중";
    case "success":
      return "🔵 신청 완료";
    case "failed":
      return "🔴 신청 실패";
    case "waiting":
      return "⏳ 대기 중";
    default:
      return "🟡 신청 대기";
  }
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

type Flow =
  | null
  | { phase: "confirm"; ids: string[]; eta: string }
  | {
      phase: "duplicate";
      ids: string[];
      duplicates: Array<{
        personId: string;
        blogName: string;
        blogId: string;
      }>;
    }
  | {
      phase: "running";
      total: number;
      current: number;
      success: number;
      failed: number;
      waiting: number;
      title: string;
      statusKind: "idle" | "running" | "success" | "failed" | "waiting";
      nextDelaySec: number | null;
    }
  | { phase: "done"; total: number; success: number; failed: number };

export function NeighborScreen({
  embedded = false,
  lazyTabs = false,
  initialSettings,
  initialCandidates,
  initialExclusions,
  initialCompleted,
  candidatesHasMore = false,
}: {
  embedded?: boolean;
  /** Defer feed / excluded / completed until tab activation. */
  lazyTabs?: boolean;
  initialSettings: NeighborSettingsView;
  initialCandidates: NeighborCandidate[];
  initialExclusions: NeighborExclusion[];
  initialCompleted: NeighborCompletedPage;
  /** Fetch full candidate list in background after initial slice. */
  candidatesHasMore?: boolean;
}) {
  const neighborPage = useNeighborPageOptional();
  const [localTab, setLocalTab] = useState<Tab>("manage");
  const tab = embedded && neighborPage ? neighborPage.tab : localTab;
  const setTab = embedded && neighborPage ? neighborPage.setTab : setLocalTab;
  const router = useRouter();
  const pathname = usePathname();

  const openManageDetail = useCallback(
    (personId: string) => {
      setTab("manage");
      const params = new URLSearchParams();
      params.set("tab", "manage");
      params.set("id", personId);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, setTab],
  );

  const [settings, setSettings] = useState(initialSettings);
  const [candidates, setCandidates] = useState(initialCandidates);
  const [exclusions, setExclusions] = useState(initialExclusions);
  const [completed, setCompleted] =
    useState<NeighborCompletedPage>(initialCompleted);
  const [completedLoading, setCompletedLoading] = useState(false);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [exclusionsLoaded, setExclusionsLoaded] = useState(!lazyTabs);
  const [completedLoaded, setCompletedLoaded] = useState(!lazyTabs);
  const [loadingMoreCandidates, setLoadingMoreCandidates] = useState(false);
  const [visibleCandidateCount, setVisibleCandidateCount] = useState(
    INITIAL_VISIBLE_CANDIDATES,
  );
  const [completedPreset, setCompletedPreset] =
    useState<CompletedRangePreset>("7d");
  const [completedStatusFilter, setCompletedStatusFilter] =
    useState<NeighborCompletedStatusFilter>(null);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [failReasons, setFailReasons] = useState<Record<string, string>>({});
  const [failModal, setFailModal] = useState<{
    personId: string;
    name: string;
    raw: string;
  } | null>(null);
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunSuccessRef = useRef(0);

  const [keywordsText, setKeywordsText] = useState(
    initialSettings.keywords.join(", "),
  );
  const [quota, setQuota] = useState(initialSettings.daily_candidate_quota);
  const [aiAnalyzeMax, setAiAnalyzeMax] = useState(
    initialSettings.ai_analyze_max ?? 50,
  );
  const [aiBatchSize, setAiBatchSize] = useState(
    initialSettings.ai_batch_size ?? 10,
  );
  const [dailyLimit, setDailyLimit] = useState(
    initialSettings.daily_request_limit,
  );
  const [msgTemplate, setMsgTemplate] = useState(initialSettings.message);
  const [delayMin, setDelayMin] = useState(initialSettings.delay_min_sec);
  const [delayMax, setDelayMax] = useState(initialSettings.delay_max_sec);
  const [statusCheckMode, setStatusCheckMode] =
    useState<NeighborStatusCheckMode>(
      initialSettings.status_check_mode ?? "daily_1",
    );
  const [feedLookback, setFeedLookback] = useState(
    initialSettings.feed_lookback_days ?? 3,
  );
  const [feedMaxPerNeighbor, setFeedMaxPerNeighbor] = useState(
    initialSettings.feed_max_per_neighbor_day ?? 1,
  );
  const [feedMaxCollect, setFeedMaxCollect] = useState(
    initialSettings.feed_max_collect_day ?? 50,
  );
  const [feedCollectMode, setFeedCollectMode] = useState<
    "manual" | "daily_1" | "daily_2" | "daily_4"
  >(initialSettings.feed_collect_mode ?? "daily_1");
  const [feedCollectHour, setFeedCollectHour] = useState(
    initialSettings.feed_collect_hour ?? 9,
  );
  const [feedAiAutoCount, setFeedAiAutoCount] = useState<5 | 10 | 20>(
    initialSettings.feed_ai_auto_count ?? 5,
  );
  const [statusChecking, setStatusChecking] = useState(false);

  const [flow, setFlow] = useState<Flow>(null);
  const [findingPhase, setFindingPhase] = useState<
    null | "searching" | "filtering" | "analyzing" | "done"
  >(null);
  const finding = findingPhase != null && findingPhase !== "done";
  const [funnel, setFunnel] = useState<NeighborPipelineFunnel | null>(null);
  const [showFunnelDetail, setShowFunnelDetail] = useState(false);
  const [aiProgress, setAiProgress] = useState<{
    current: number;
    total: number;
    phase: "preparing" | "requesting" | "running" | "done";
    batchIndex?: number;
    batchTotal?: number;
    statusLabel?: string;
    openaiRequests?: number;
    openaiSuccess?: number;
    openaiFail?: number;
  } | null>(null);

  const visibleCandidates = useMemo(
    () => candidates.slice(0, visibleCandidateCount),
    [candidates, visibleCandidateCount],
  );

  const hasMoreCandidatesToShow = candidates.length > visibleCandidateCount;

  const selectable = useMemo(
    () =>
      candidates.filter(
        (c) => !c.hasOpenApproval && !c.alreadyRequested,
      ),
    [candidates],
  );

  const selectState = useMemo(() => {
    const ids = selectable.map((c) => c.personId);
    if (ids.length === 0) return "none" as const;
    const selectedCount = ids.filter((id) => selected.has(id)).length;
    if (selectedCount === 0) return "none" as const;
    if (selectedCount === ids.length) return "all" as const;
    return "partial" as const;
  }, [selectable, selected]);

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectState === "partial";
    }
  }, [selectState]);

  useEffect(() => {
    if (!lazyTabs || exclusionsLoaded || tab !== "excluded") return;
    let cancelled = false;
    setSecondaryLoading(true);
    void listNeighborExclusionsAction()
      .then((rows) => {
        if (!cancelled) setExclusions(rows);
      })
      .finally(() => {
        if (!cancelled) {
          setExclusionsLoaded(true);
          setSecondaryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [exclusionsLoaded, lazyTabs, tab]);

  useEffect(() => {
    if (!lazyTabs || completedLoaded || tab !== "completed") return;
    let cancelled = false;
    setCompletedLoading(true);
    void listNeighborCompletedAction(1, 15, { preset: "7d" })
      .then((page) => {
        if (!cancelled) setCompleted(page);
      })
      .finally(() => {
        if (!cancelled) {
          setCompletedLoaded(true);
          setCompletedLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [completedLoaded, lazyTabs, tab]);

  useEffect(() => {
    if (!candidatesHasMore) return;
    let cancelled = false;
    setLoadingMoreCandidates(true);
    void listNeighborCandidatesAction()
      .then((all) => {
        if (!cancelled) setCandidates(all);
      })
      .finally(() => {
        if (!cancelled) setLoadingMoreCandidates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidatesHasMore]);

  function toggleSelectAll() {
    if (selectState === "all") {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(selectable.map((c) => c.personId)));
  }

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function goToCompletedTab() {
    setTab("completed");
  }

  async function maybeAutoCheckNeighborStatus() {
    if (settings.status_check_mode === "manual") return;
    if (statusChecking) return;
    setStatusChecking(true);
    try {
      const summary = await checkPendingNeighborStatusesAction({
        force: false,
        limit: 10,
      });
      if (summary.checked > 0) {
        await loadCompletedPage(1);
        const fresh = await getNeighborScreenAction();
        setSettings(fresh.settings);
      }
    } finally {
      setStatusChecking(false);
    }
  }

  useEffect(() => {
    if (tab !== "completed") return;
    void maybeAutoCheckNeighborStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when tab opens
  }, [tab]);

  function completedQueryOptions() {
    return {
      preset: completedPreset,
      fromDate: completedPreset === "custom" ? customFrom : undefined,
      toDate: completedPreset === "custom" ? customTo : undefined,
      statusFilter: completedStatusFilter,
    };
  }

  async function loadCompletedPage(page: number) {
    setCompletedLoading(true);
    try {
      const next = await listNeighborCompletedAction(page, PAGE_SIZE, {
        ...completedQueryOptions(),
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
    if (preset === "custom") {
      if (fromDate) setCustomFrom(fromDate);
      if (toDate) setCustomTo(toDate);
    }
    setCompletedLoading(true);
    try {
      const next = await listNeighborCompletedAction(1, PAGE_SIZE, {
        preset,
        fromDate: preset === "custom" ? fromDate ?? customFrom : undefined,
        toDate: preset === "custom" ? toDate ?? customTo : undefined,
        statusFilter: completedStatusFilter,
      });
      setCompleted(next);
    } finally {
      setCompletedLoading(false);
    }
  }

  async function toggleCompletedStatusFilter(
    next: NeighborCompletedStatusFilter,
  ) {
    const applied = completedStatusFilter === next ? null : next;
    setCompletedStatusFilter(applied);
    setCompletedLoading(true);
    try {
      const page = await listNeighborCompletedAction(1, PAGE_SIZE, {
        preset: completedPreset,
        fromDate: completedPreset === "custom" ? customFrom : undefined,
        toDate: completedPreset === "custom" ? customTo : undefined,
        statusFilter: applied,
      });
      setCompleted(page);
    } finally {
      setCompletedLoading(false);
    }
  }

  useEffect(() => {
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    };
  }, []);

  async function requestBatch(personIds: string[]) {
    if (personIds.length === 0) return;
    if (settings.today_remaining <= 0) {
      setMessage("오늘 서로이웃 추가 가능 수량을 모두 사용했습니다.");
      return;
    }
    const capped = personIds.slice(0, settings.today_remaining);
    const check = await checkNeighborDuplicatesAction(capped);
    if (check.duplicates.length > 0) {
      setFlow({
        phase: "duplicate",
        ids: capped,
        duplicates: check.duplicates.map((d) => ({
          personId: d.personId,
          blogName: d.blogName,
          blogId: d.blogId,
        })),
      });
      return;
    }
    setFlow({
      phase: "confirm",
      ids: capped,
      eta: formatEta(capped.length, delayMin, delayMax),
    });
  }

  async function runBatch(personIds: string[]) {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current);
      autoCloseRef.current = null;
    }

    setFlow({
      phase: "running",
      total: personIds.length,
      current: 0,
      success: 0,
      failed: 0,
      waiting: personIds.length,
      title: "-",
      statusKind: "idle",
      nextDelaySec: null,
    });

    let success = 0;
    let failed = 0;
    const succeededIds: string[] = [];
    const newFailReasons: Record<string, string> = {};

    for (let i = 0; i < personIds.length; i++) {
      const personId = personIds[i]!;
      const cand = candidates.find((c) => c.personId === personId);
      const title = cand?.blogName ?? personId.slice(0, 8);
      setFlow({
        phase: "running",
        total: personIds.length,
        current: i + 1,
        success,
        failed,
        waiting: Math.max(0, personIds.length - (i + 1)),
        title,
        statusKind: "running",
        nextDelaySec: null,
      });
      await sleep(20);

      const created = await createNeighborRequestApprovalAction(personId);
      if (!created.ok || !created.approvalId) {
        failed += 1;
        newFailReasons[personId] =
          created.errorMessage?.trim() ||
          "서로이웃 신청을 시작하지 못했습니다.";
        await markNeighborRequestFailedAction(
          personId,
          newFailReasons[personId],
        );
        setFlow({
          phase: "running",
          total: personIds.length,
          current: i + 1,
          success,
          failed,
          waiting: Math.max(0, personIds.length - (i + 1)),
          title,
          statusKind: "failed",
          nextDelaySec: null,
        });
        continue;
      }

      const outcome = await approveApprovalAction(
        created.approvalId,
        undefined,
        undefined,
      );
      if (outcome.excluded) {
        const msg =
          outcome.errorMessage?.trim() || "서로이웃 신청을 건너뛰었습니다.";
        newFailReasons[personId] = msg;
        setFailModal({
          personId,
          name: title,
          raw: msg,
        });
        setFlow({
          phase: "running",
          total: personIds.length,
          current: i + 1,
          success,
          failed,
          waiting: Math.max(0, personIds.length - (i + 1)),
          title,
          statusKind: "failed",
          nextDelaySec: null,
        });
      } else if (outcome.ok) {
        success += 1;
        succeededIds.push(personId);
        await markNeighborRequestedAction(personId);
        setFlow({
          phase: "running",
          total: personIds.length,
          current: i + 1,
          success,
          failed,
          waiting: Math.max(0, personIds.length - (i + 1)),
          title,
          statusKind: "success",
          nextDelaySec: null,
        });
      } else {
        failed += 1;
        newFailReasons[personId] =
          outcome.errorMessage?.trim() || "서로이웃 신청에 실패했습니다.";
        await markNeighborRequestFailedAction(
          personId,
          newFailReasons[personId],
        );
        setFlow({
          phase: "running",
          total: personIds.length,
          current: i + 1,
          success,
          failed,
          waiting: Math.max(0, personIds.length - (i + 1)),
          title,
          statusKind: "failed",
          nextDelaySec: null,
        });
      }

      if (i < personIds.length - 1) {
        const delayMs = resolveBatchQueueDelayMs({
          minMs: delayMin * 1000,
          maxMs: Math.max(delayMin, delayMax) * 1000,
        });
        const end = Date.now() + delayMs;
        while (Date.now() < end) {
          setFlow((prev) =>
            prev && prev.phase === "running"
              ? {
                  ...prev,
                  statusKind: "waiting",
                  nextDelaySec: Math.max(
                    0,
                    Math.ceil((end - Date.now()) / 1000),
                  ),
                }
              : prev,
          );
          await sleep(200);
        }
      }
    }

    if (succeededIds.length > 0) {
      setCandidates((prev) =>
        prev.filter((c) => !succeededIds.includes(c.personId)),
      );
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
      setFailReasons((prev) => {
        const next = { ...prev };
        for (const id of succeededIds) delete next[id];
        return next;
      });
    }
    if (Object.keys(newFailReasons).length > 0) {
      setFailReasons((prev) => ({ ...prev, ...newFailReasons }));
      // 실패도 처리완료로 이동 — 후보 목록에서 제거
      setCandidates((prev) =>
        prev.filter((c) => !newFailReasons[c.personId]),
      );
    }

    lastRunSuccessRef.current = success;
    setFlow({
      phase: "done",
      total: personIds.length,
      success,
      failed,
    });

    const freshSettings = await getNeighborScreenAction();
    setSettings(freshSettings.settings);
    await loadCompletedPage(1);

    if (success > 0) {
      goToCompletedTab();
    }

    autoCloseRef.current = setTimeout(() => {
      setFlow(null);
      if (lastRunSuccessRef.current > 0) goToCompletedTab();
    }, 8_000);
  }

  return (
    <div
      className={
        embedded
          ? "flex flex-col gap-4"
          : "mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-56 pt-6"
      }
    >
      {embedded ? (
        <NeighborQuotaHintSync
          todayExecuted={settings.today_executed}
          todayFailed={settings.today_failed}
          todayExcluded={settings.today_excluded}
          dailyLimit={settings.daily_request_limit}
          todayRemaining={settings.today_remaining}
        />
      ) : (
        <header className="space-y-2">
          <Link
            href="/today"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            ← Agent Brief
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">서로이웃 관리</h1>
          <p className="text-sm text-muted-foreground">
            오늘 신청 {settings.today_executed}/{settings.daily_request_limit} ·
            성공 {settings.today_executed}건 · 실패 {settings.today_failed}건 ·
            제외 {settings.today_excluded}건 · 남은 한도{" "}
            {settings.today_remaining}건
          </p>
        </header>
      )}

      {message ? (
        <div className="rounded-lg border border-border/70 bg-secondary/50 px-3 py-2 text-sm">
          {message}
          <button
            type="button"
            className="ml-2 text-xs underline"
            onClick={() => setMessage(null)}
          >
            닫기
          </button>
        </div>
      ) : null}

      {!embedded ? (
        <div className="flex flex-wrap gap-1 rounded-xl border border-border/70 bg-secondary/40 p-1">
          {(
            [
              ["candidates", "추천 이웃"],
              ["completed", "신청 관리"],
              ["manage", "이웃 관리"],
              ["excluded", "제외"],
              ["feed", "이웃 새글"],
              ["settings", "설정"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex-1 rounded-lg px-2 py-2 text-xs font-medium ${
                tab === id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {tab === "candidates" ? (
        <div className="flex flex-col gap-3">
          <NeighborCandidatesSummary
            candidateCount={candidates.length}
            todayExecuted={settings.today_executed}
            todayFailed={settings.today_failed}
            todayExcluded={settings.today_excluded}
            dailyLimit={settings.daily_request_limit}
            todayRemaining={settings.today_remaining}
          />
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              disabled={finding || pending || flow != null}
              onClick={() => {
                void (async () => {
                  setFindingPhase("searching");
                  setMessage(null);
                  setFunnel(null);
                  setAiProgress(null);
                  try {
                    const search = await searchNeighborCandidatesAction();
                    setFunnel(search.funnel);
                    if (search.hits.length === 0) {
                      setMessage(
                        search.message ||
                          "검색 결과가 없습니다. 키워드를 확인해 주세요.",
                      );
                      setFindingPhase(null);
                      return;
                    }

                    setFindingPhase("filtering");
                    const filtered = await filterNeighborCandidatesAction({
                      hits: search.hits,
                      remainingQuota: search.remainingQuota,
                      searchSource: search.searchSource,
                      filterMax: search.filterMax,
                      aiAnalyzeMax: settings.ai_analyze_max ?? 50,
                      funnel: search.funnel,
                    });
                    setFunnel(filtered.funnel);

                    if (
                      filtered.toAnalyze.length === 0 &&
                      filtered.reused.length === 0
                    ) {
                      setMessage("조건에 맞는 후보가 부족합니다.");
                      setFindingPhase(null);
                      return;
                    }

                    setFindingPhase("analyzing");
                    const queue = filtered.toAnalyze;
                    const total = queue.length;
                    const BATCH = Math.min(
                      20,
                      Math.max(5, settings.ai_batch_size ?? 10),
                    );
                    const CONCURRENCY = Math.min(
                      3,
                      Math.max(1, settings.ai_concurrency ?? 2),
                    );
                    const TIMEOUT_MS = 45_000;
                    setAiProgress({
                      current: 0,
                      total,
                      phase: "preparing",
                      statusLabel: "AI 분석 요청 준비 중",
                      openaiRequests: 0,
                      openaiSuccess: 0,
                      openaiFail: 0,
                    });
                    // Let React paint "준비 중" before first API call
                    await sleep(80);

                    const judgments: Awaited<
                      ReturnType<typeof analyzeNeighborAiBatchAction>
                    >["judgments"] = [];
                    let analyzed = 0;
                    let rejected = 0;
                    let failed = 0;
                    let openaiRequests = 0;
                    let openaiSuccess = 0;
                    let openaiFail = 0;
                    const chunks: (typeof queue)[] = [];
                    for (let i = 0; i < queue.length; i += BATCH) {
                      chunks.push(queue.slice(i, i + BATCH));
                    }
                    const batchTotal = chunks.length;
                    console.log(
                      `[neighbor-ai] candidates=${total} batches=${batchTotal} size=${BATCH} concurrency=${CONCURRENCY}`,
                    );

                    // Worker queue (not Promise.all on all batches):
                    // free workers pull next chunk — one slow batch only occupies one slot.
                    let completed = 0;
                    let nextIdx = 0;
                    const inFlight = new Set<number>();

                    const runWorker = async () => {
                      while (nextIdx < chunks.length) {
                        const i = nextIdx;
                        nextIdx += 1;
                        const chunk = chunks[i]!;
                        const batchIndex = i + 1;
                        inFlight.add(batchIndex);
                        setAiProgress({
                          current: completed,
                          total,
                          phase: "requesting",
                          batchIndex,
                          batchTotal,
                          statusLabel: `AI 분석 중 ${batchIndex}차 배치 요청 중`,
                          openaiRequests,
                          openaiSuccess,
                          openaiFail,
                        });
                        console.log(
                          `[neighbor-ai] batch start ${batchIndex}/${batchTotal} size=${chunk.length}`,
                        );
                        try {
                          const slimRows = chunk.map(toNeighborAiRowInput);
                          const timed = await new Promise<
                            Awaited<
                              ReturnType<typeof analyzeNeighborAiBatchAction>
                            >
                          >((resolve, reject) => {
                            let settled = false;
                            const timer = window.setTimeout(() => {
                              if (settled) return;
                              settled = true;
                              reject(
                                new Error(
                                  `client batch timeout ${TIMEOUT_MS}ms`,
                                ),
                              );
                            }, TIMEOUT_MS + 2_000);

                            void analyzeNeighborAiBatchAction({
                              rows: slimRows as Parameters<
                                typeof analyzeNeighborAiBatchAction
                              >[0]["rows"],
                              keywords: filtered.keywords,
                              batchIndex,
                              batchTotal,
                              timeoutMs: TIMEOUT_MS,
                            })
                              .then((value) => {
                                if (settled) return;
                                settled = true;
                                window.clearTimeout(timer);
                                resolve(value);
                              })
                              .catch((err) => {
                                if (settled) return;
                                settled = true;
                                window.clearTimeout(timer);
                                reject(err);
                              });
                          });
                          judgments.push(...timed.judgments);
                          analyzed += timed.analyzed;
                          rejected += timed.rejected;
                          failed += timed.failed;
                          openaiRequests += timed.openaiRequests;
                          openaiSuccess += timed.openaiSuccess;
                          openaiFail += timed.openaiFail;
                          console.log(
                            `[neighbor-ai] batch done ${batchIndex}/${batchTotal} openai=${timed.openaiRequests} ok=${timed.openaiSuccess} fail=${timed.openaiFail}`,
                          );
                        } catch (err) {
                          console.warn(
                            `[neighbor-ai] batch fail ${batchIndex}/${batchTotal}`,
                            err instanceof Error ? err.message : err,
                          );
                          failed += chunk.length;
                          analyzed += chunk.length;
                          openaiRequests += 1;
                          openaiFail += 1;
                        } finally {
                          inFlight.delete(batchIndex);
                        }
                        completed += chunk.length;
                        const active = [...inFlight];
                        setAiProgress({
                          current: Math.min(completed, total),
                          total,
                          phase: "running",
                          batchIndex,
                          batchTotal,
                          statusLabel:
                            completed >= total
                              ? "AI 분석 결과 정리 중"
                              : active.length > 0
                                ? `AI 분석 중 ${completed}/${total} · ${active.map((n) => `${n}차`).join(",")} 진행`
                                : `AI 분석 중 ${completed}/${total}`,
                          openaiRequests,
                          openaiSuccess,
                          openaiFail,
                        });
                      }
                    };
                    await Promise.all(
                      Array.from(
                        {
                          length: Math.min(
                            CONCURRENCY,
                            chunks.length || 1,
                          ),
                        },
                        () => runWorker(),
                      ),
                    );

                    const result = await finalizeNeighborCollectAction({
                      filterResult: filtered,
                      judgments,
                      analyzed,
                      rejected,
                      failed,
                      openaiRequests,
                      openaiSuccess,
                      openaiFail,
                    });
                    setFunnel(result.funnel);
                    setAiProgress({
                      current: total,
                      total,
                      phase: "done",
                      statusLabel: "AI 분석 완료",
                      openaiRequests,
                      openaiSuccess,
                      openaiFail,
                    });

                    setFindingPhase("done");
                    setMessage(
                      result.message ||
                        `추천 후보 ${result.added}명이 추가되었습니다`,
                    );
                    const fresh = await getNeighborScreenAction();
                    setCandidates(fresh.candidates);
                    setSettings(fresh.settings);
                    setExclusions(fresh.exclusions);
                    await sleep(800);
                  } catch {
                    setMessage(
                      "후보를 찾는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
                    );
                  } finally {
                    setFindingPhase(null);
                    setAiProgress(null);
                  }
                })();
              }}
            >
              {finding ? "찾는 중…" : "후보 새로 찾기"}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              검색 → 코드 점수 상위{" "}
              {settings.ai_analyze_max ?? settings.daily_candidate_quota * 2}명
              AI({settings.ai_batch_size ?? 10}명×병렬{" "}
              {settings.ai_concurrency ?? 2}) → 하루{" "}
              {settings.daily_candidate_quota}명 저장
              <span className="block text-[10px] opacity-80">
                모델: NEIGHBOR_AI_MODEL (기본 gpt-4o-mini, 45초 timeout)
              </span>
            </p>
          </div>

          {findingPhase ? (
            <div className="rounded-xl border border-border/70 bg-secondary/40 px-4 py-6">
              <p className="text-center text-sm font-medium">
                {findingPhase === "searching"
                  ? "① 검색 중"
                  : findingPhase === "filtering"
                    ? "② 1차 필터링 중"
                    : findingPhase === "analyzing"
                      ? "③ AI 분석 중"
                      : "④ 완료"}
              </p>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {findingPhase === "searching"
                  ? "네이버 검색 API에서 후보를 찾는 중입니다"
                  : findingPhase === "filtering"
                    ? "광고성/비활성/중복을 제외하고 코드 점수로 순위를 매기는 중입니다"
                    : findingPhase === "analyzing"
                      ? aiProgress?.phase === "preparing"
                        ? "AI 분석 요청 준비 중"
                        : aiProgress?.statusLabel
                          ? aiProgress.statusLabel
                          : "AI 분석 요청 준비 중"
                      : "추천 후보 저장을 마쳤습니다"}
              </p>
              {findingPhase === "analyzing" &&
              aiProgress &&
              (aiProgress.openaiRequests ?? 0) > 0 ? (
                <p className="mt-1 text-center text-[11px] text-muted-foreground">
                  AI 요청 {aiProgress.openaiRequests}회 · 성공{" "}
                  {aiProgress.openaiSuccess ?? 0} · 실패{" "}
                  {aiProgress.openaiFail ?? 0}
                </p>
              ) : null}
              {findingPhase === "analyzing" && aiProgress && aiProgress.total > 0 ? (
                <div className="mx-auto mt-3 h-2 w-full max-w-xs overflow-hidden rounded-full bg-border/80">
                  <div
                    className="h-full rounded-full bg-foreground/70 transition-[width] duration-300"
                    style={{
                      width: `${Math.round(
                        (aiProgress.current / Math.max(1, aiProgress.total)) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
              ) : null}
              <ol className="mx-auto mt-4 max-w-xs space-y-2 text-xs">
                {(
                  [
                    ["searching", "검색 중"],
                    ["filtering", "1차 필터링 중"],
                    ["analyzing", "AI 분석 중"],
                    ["done", "완료"],
                  ] as const
                ).map(([id, label]) => {
                  const order = {
                    searching: 0,
                    filtering: 1,
                    analyzing: 2,
                    done: 3,
                  } as const;
                  const current = order[findingPhase];
                  const step = order[id];
                  const active = findingPhase === id;
                  const completed = current > step;
                  return (
                    <li
                      key={id}
                      className={`flex items-center gap-2 ${
                        active
                          ? "font-medium text-foreground"
                          : completed
                            ? "text-foreground/80"
                            : "text-muted-foreground"
                      }`}
                    >
                      <span className="inline-flex size-5 items-center justify-center rounded-full border border-border/80 text-[10px]">
                        {completed || findingPhase === "done" ? "✓" : step + 1}
                      </span>
                      {label}
                      {active && findingPhase !== "done" ? (
                        <span className="ml-auto animate-pulse text-[10px]">
                          …
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {funnel ? (
            <div className="rounded-xl border border-border/70 bg-card p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm">
                  검색 {funnel.apiRawCount} → 고유{" "}
                  <span className="font-semibold">{funnel.afterDedupe}</span> →
                  필터 {funnel.filterPassed} → 추가{" "}
                  <span className="font-semibold">{funnel.finalAdded}</span>
                </p>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setShowFunnelDetail((v) => !v)}
                >
                  {showFunnelDetail ? "간단히" : "상세 수치"}
                </button>
              </div>
              {showFunnelDetail ? (
                <div className="mt-3 border-t border-border/60 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-medium">수집 파이프라인 수치</h2>
                    <button
                      type="button"
                      className="text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => setFunnel(null)}
                    >
                      닫기
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    출처: {funnel.searchSource} · 키워드{" "}
                    {funnel.keywords.slice(0, 4).join(", ")}
                    {funnel.keywords.length > 4 ? "…" : ""}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {(
                      [
                        ["API 검색(원본)", funnel.apiRawCount],
                        ["중복 제거 후", funnel.afterDedupe],
                        ["1차 필터 입력", funnel.filterInput],
                        ["1차 필터 통과", funnel.filterPassed],
                        ["AI 분석 대상", funnel.aiTarget],
                        ["AI 재사용(7일내)", funnel.aiReused],
                        ["AI 분석 실행", funnel.aiAnalyzed],
                        ["AI 탈락", funnel.aiRejected],
                        ["AI 요청(회)", funnel.aiOpenaiRequests],
                        ["AI 요청 성공", funnel.aiOpenaiSuccess],
                        ["AI 요청 실패", funnel.aiOpenaiFail],
                        ["최종 신규 추가", funnel.finalAdded],
                        ["기존 갱신", funnel.finalUpdated],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="font-medium tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-3 border-t border-border/60 pt-3">
                    <p className="mb-1.5 font-medium">탈락 사유</p>
                    <ul className="space-y-1 text-muted-foreground">
                      {(
                        [
                          ["blog_id 중복", funnel.rejects.duplicate_blog_id],
                          ["제외 목록", funnel.rejects.excluded],
                          ["신청/처리 완료", funnel.rejects.already_requested],
                          ["이미 분석(7일내)", funnel.rejects.already_analyzed],
                          ["비활성(1년+)", funnel.rejects.inactive],
                          ["광고/협찬", funnel.rejects.ad_heavy],
                          ["기업/브랜드", funnel.rejects.corporate],
                          ["키워드 무관", funnel.rejects.topic_mismatch],
                          ["코드점수 하위(AI 제외)", funnel.rejects.filter_cap_skipped],
                          ["AI 거절", funnel.rejects.ai_rejected],
                          ["AI 배치 실패", funnel.rejects.ai_failed],
                          ["기존 후보 갱신", funnel.rejects.updated_existing],
                          ["저장 한도", funnel.rejects.save_quota_skipped],
                          ["verify 스킵", funnel.rejects.verify_skipped],
                          ["저장 오류", funnel.rejects.persist_error],
                        ] as const
                      )
                        .filter(([, n]) => n > 0)
                        .map(([label, n]) => (
                          <li
                            key={label}
                            className="flex justify-between gap-2"
                          >
                            <span>{label}</span>
                            <span className="tabular-nums text-foreground">
                              {n}
                            </span>
                          </li>
                        ))}
                      {Object.values(funnel.rejects).every((n) => n === 0) ? (
                        <li>탈락 없음</li>
                      ) : null}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{candidates.length}명 추천</span>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border border-border/70 px-2.5 py-1.5 text-xs hover:bg-secondary/60"
              onClick={toggleSelectAll}
              disabled={selectable.length === 0 || flow != null}
            >
              <input
                ref={selectAllRef}
                type="checkbox"
                className="size-3.5"
                checked={selectState === "all"}
                readOnly
                tabIndex={-1}
              />
              {selectState === "all"
                ? "전체 선택됨"
                : selectState === "partial"
                  ? "부분 선택"
                  : "전체 선택"}
            </button>
          </div>
          {loadingMoreCandidates ? (
            <p className="text-center text-xs text-muted-foreground">
              나머지 후보 불러오는 중…
            </p>
          ) : null}
          {candidates.length === 0 && !finding ? (
            <p className="rounded-xl border border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
              추천 후보가 없습니다.
              <br />
              <span className="mt-2 block text-xs">
                상단 <strong>후보 새로 찾기</strong>로 키워드 기반 수집을
                실행하세요. 키워드는 설정 탭에서 수정할 수 있습니다.
              </span>
            </p>
          ) : (
            <>
              {visibleCandidates.map((c) => (
                <NeighborCandidateCard
                  key={c.personId}
                  candidate={c}
                  selected={selected.has(c.personId)}
                  selectionDisabled={
                    c.hasOpenApproval || c.alreadyRequested || pending
                  }
                  requestDisabled={
                    pending ||
                    flow != null ||
                    c.hasOpenApproval ||
                    c.alreadyRequested
                  }
                  excludeDisabled={pending}
                  failReason={failReasons[c.personId] ?? null}
                  onToggleSelect={(checked) => toggle(c.personId, checked)}
                  onRequest={() => void requestBatch([c.personId])}
                  onExclude={() =>
                    start(async () => {
                      await excludeNeighborBlogAction({
                        blogId: c.blogId,
                        blogName: c.blogName,
                        blogUrl: c.blogUrl ?? undefined,
                        personId: c.personId,
                      });
                      setCandidates((prev) =>
                        prev.filter((x) => x.personId !== c.personId),
                      );
                      setExclusions((prev) => [
                        {
                          blog_id: c.blogId,
                          blog_name: c.blogName,
                          blog_url: c.blogUrl,
                          note: null,
                          excluded_at: new Date().toISOString(),
                        },
                        ...prev,
                      ]);
                    })
                  }
                  onShowFailReason={() =>
                    setFailModal({
                      personId: c.personId,
                      name: c.blogName,
                      raw: failReasons[c.personId]!,
                    })
                  }
                />
              ))}
              {hasMoreCandidatesToShow ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    setVisibleCandidateCount((count) =>
                      Math.min(count + CANDIDATES_LOAD_MORE_STEP, candidates.length),
                    )
                  }
                >
                  더 보기 ({candidates.length - visibleCandidateCount}명 남음)
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {tab === "manage" ? <NeighborManagePanel /> : null}

      {tab === "feed" ? (
        <NeighborFeedPanel
          initialLastCollectAt={settings.feed_last_collect_at ?? null}
        />
      ) : null}

      {tab === "excluded" ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">제외한 블로그</h2>
          {secondaryLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          ) : exclusions.length === 0 ? (
            <p className="text-sm text-muted-foreground">제외 목록이 비어 있습니다.</p>
          ) : (
            exclusions.map((e) => (
              <div
                key={e.blog_id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {e.blog_name ?? e.blog_id}
                  </p>
                  <p className="text-xs text-muted-foreground">{e.blog_id}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await allowNeighborBlogAgainAction(e.blog_id);
                      setExclusions((prev) =>
                        prev.filter((x) => x.blog_id !== e.blog_id),
                      );
                      router.refresh();
                    })
                  }
                >
                  다시 추천 허용
                </Button>
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === "completed" ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-border/70 bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">기간</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(
                ["today", "7d", "30d", "custom"] as CompletedRangePreset[]
              ).map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={completedLoading}
                  onClick={() => {
                    if (p === "custom") {
                      setCompletedPreset("custom");
                      return;
                    }
                    void changeCompletedRange(p);
                  }}
                  className={`rounded-md border px-2.5 py-1.5 text-xs ${
                    completedPreset === p
                      ? "border-foreground/50 bg-secondary font-medium"
                      : "border-border/60 text-muted-foreground"
                  }`}
                >
                  {completedRangePresetLabel(p)}
                </button>
              ))}
            </div>
            {completedPreset === "custom" ? (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  시작
                  <input
                    type="date"
                    value={customFrom}
                    disabled={completedLoading}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  종료
                  <input
                    type="date"
                    value={customTo}
                    disabled={completedLoading}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
                  />
                </label>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    completedLoading || !customFrom || !customTo
                  }
                  onClick={() =>
                    void changeCompletedRange("custom", customFrom, customTo)
                  }
                >
                  적용
                </Button>
              </div>
            ) : null}

            <div className="mt-4 space-y-2 rounded-lg bg-secondary/50 px-3 py-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">
                {completed.rangeLabel || "기간"} 처리 · 클릭하여 필터
              </p>
              {(
                [
                  {
                    key: "accepted" as const,
                    emoji: "🟢",
                    label: "서로이웃 완료",
                    count: completed.rangeAcceptedCount ?? 0,
                  },
                  {
                    key: "requested" as const,
                    emoji: "🟡",
                    label: "신청 완료",
                    count: completed.rangeRequestedCount ?? 0,
                  },
                  {
                    key: "failed" as const,
                    emoji: "🔴",
                    label: "신청 실패",
                    count: completed.rangeFailedCount ?? 0,
                  },
                ] as const
              ).map((row) => {
                const active = completedStatusFilter === row.key;
                return (
                  <button
                    key={row.key}
                    type="button"
                    disabled={completedLoading}
                    onClick={() => void toggleCompletedStatusFilter(row.key)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors ${
                      active
                        ? "bg-foreground/10 ring-1 ring-foreground/30"
                        : "hover:bg-background/60"
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span>{row.emoji}</span>
                      <span className={active ? "font-medium text-foreground" : ""}>
                        {row.label}
                      </span>
                    </span>
                    <span
                      className={`font-semibold ${active ? "text-foreground" : ""}`}
                    >
                      {row.count}건
                    </span>
                  </button>
                );
              })}
              {completedStatusFilter ? (
                <button
                  type="button"
                  className="w-full pt-1 text-center text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => void toggleCompletedStatusFilter(completedStatusFilter)}
                >
                  필터 해제 · 전체 보기
                </button>
              ) : null}
              <p className="pt-1 text-[11px] text-muted-foreground">
                오늘: 완료 {completed.todayAcceptedCount ?? 0} · 신청{" "}
                {completed.todayRequestedCount ?? 0} · 실패{" "}
                {completed.todayFailedCount ?? 0}
              </p>
            </div>
            <Button
              className="mt-3 w-full"
              variant="secondary"
              size="sm"
              disabled={statusChecking || completedLoading}
              onClick={() => {
                void (async () => {
                  setStatusChecking(true);
                  try {
                    const summary = await checkPendingNeighborStatusesAction({
                      force: true,
                      limit: 15,
                    });
                    setMessage(
                      `상태 확인: 서로이웃 완료 ${summary.accepted} · 승인 대기 ${summary.stillPending} · 미확인 ${summary.unknown}`,
                    );
                    await loadCompletedPage(completed.page);
                    const fresh = await getNeighborScreenAction();
                    setSettings(fresh.settings);
                  } finally {
                    setStatusChecking(false);
                  }
                })();
              }}
            >
              {statusChecking ? "상태 확인 중…" : "상태 다시 확인"}
            </Button>
          </div>

          {completedLoading ? (
            <p className="text-center text-xs text-muted-foreground">
              불러오는 중…
            </p>
          ) : null}

          {completed.total === 0 ? (
            <p className="rounded-xl border border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
              선택한 기간에 처리 완료된 서로이웃 신청이 없습니다.
            </p>
          ) : (
            <>
              {completed.items.map((item) => {
                const rel = neighborRelationStatusLabel(item.relationStatus);
                const isAccepted = item.relationStatus === "accepted";
                return (
                  <article
                    key={item.approvalId}
                    role={isAccepted ? "button" : undefined}
                    tabIndex={isAccepted ? 0 : undefined}
                    onClick={
                      isAccepted
                        ? () => openManageDetail(item.personId)
                        : undefined
                    }
                    onKeyDown={
                      isAccepted
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openManageDetail(item.personId);
                            }
                          }
                        : undefined
                    }
                    className={`rounded-xl border border-border/70 bg-card p-4${
                      isAccepted
                        ? " cursor-pointer transition-colors hover:bg-secondary/40"
                        : ""
                    }`}
                  >
                    <p className="text-xs font-medium">
                      {rel.emoji} {rel.label}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatApprovalFailureTime(item.resolvedAt)}
                      {item.statusCheckedAt
                        ? ` · 확인 ${formatApprovalFailureTime(item.statusCheckedAt)}`
                        : ""}
                    </p>
                    <h2 className="mt-1 text-sm font-semibold">
                      {item.personName}
                    </h2>
                    {item.blogId ? (
                      <p className="text-xs text-muted-foreground">
                        {item.blogId}
                      </p>
                    ) : null}
                    {item.draftBody ? (
                      <blockquote className="mt-2 rounded-lg bg-secondary/60 px-3 py-2 text-sm">
                        {item.draftBody}
                      </blockquote>
                    ) : null}
                    {item.relationStatus === "failed" ? (
                      <button
                        type="button"
                        className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFailModal({
                            personId: item.personId,
                            name: item.personName,
                            raw:
                              item.errorMessage?.trim() ||
                              failReasons[item.personId] ||
                              "서로이웃 신청에 실패했습니다.",
                          });
                        }}
                      >
                        실패 이유 보기
                      </button>
                    ) : null}
                    {isAccepted ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        이웃 관리 보기 →
                      </p>
                    ) : null}
                  </article>
                );
              })}
              <div className="flex flex-col items-center gap-2 pt-2">
                <p className="text-xs text-muted-foreground">
                  처리완료 · {completed.page}/{completed.totalPages}페이지
                </p>
                <div className="flex flex-wrap items-center justify-center gap-1">
                  {pageNumbers(completed.page, completed.totalPages).map(
                    (n, idx) =>
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
                          disabled={completedLoading || n === completed.page}
                          onClick={() => void loadCompletedPage(n)}
                          className={`min-w-8 rounded-md border px-2 py-1 text-xs ${
                            n === completed.page
                              ? "border-foreground/50 bg-secondary font-medium"
                              : "border-border/60 text-muted-foreground"
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
          <Link
            href="/today/approvals"
            className="text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Approval Inbox에서 승인 대기 건 보기
          </Link>
        </div>
      ) : null}

      {tab === "settings" ? (
        <div className="flex flex-col gap-4 rounded-xl border border-border/70 bg-card p-4">
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">추천 키워드</span>
            <textarea
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              placeholder="맛집, 여행, 캠핑…"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              후보 생성량 (명/일)
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={quota}
              onChange={(e) => setQuota(Number(e.target.value) || 30)}
              className="w-20 rounded-md border border-input px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              AI 분석 최대 후보 수
            </span>
            <input
              type="number"
              min={5}
              max={100}
              value={aiAnalyzeMax}
              onChange={(e) => setAiAnalyzeMax(Number(e.target.value) || 50)}
              className="w-20 rounded-md border border-input px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              AI batch 크기 (5–20)
            </span>
            <input
              type="number"
              min={5}
              max={20}
              value={aiBatchSize}
              onChange={(e) => setAiBatchSize(Number(e.target.value) || 10)}
              className="w-20 rounded-md border border-input px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              하루 최대 신청 건수
            </span>
            <input
              type="number"
              min={0}
              max={100}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(Number(e.target.value) || 0)}
              className="w-20 rounded-md border border-input px-2 py-1 text-sm"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs text-muted-foreground">실행 간격(초)</span>
            <input
              type="number"
              min={0}
              value={delayMin}
              onChange={(e) => setDelayMin(Number(e.target.value) || 0)}
              className="w-16 rounded-md border border-input px-2 py-1 text-sm"
            />
            <span>~</span>
            <input
              type="number"
              min={0}
              value={delayMax}
              onChange={(e) => setDelayMax(Number(e.target.value) || 0)}
              className="w-16 rounded-md border border-input px-2 py-1 text-sm"
            />
          </div>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">
              서로이웃 상태 확인 주기
            </span>
            <select
              value={statusCheckMode}
              onChange={(e) =>
                setStatusCheckMode(e.target.value as NeighborStatusCheckMode)
              }
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="daily_1">{statusCheckModeLabel("daily_1")}</option>
              <option value="daily_2">{statusCheckModeLabel("daily_2")}</option>
              <option value="manual">{statusCheckModeLabel("manual")}</option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              신청 완료(상대 승인 대기) 건을 CDP로 확인해 서로이웃 완료로
              갱신합니다.
            </p>
          </label>
          <p className="text-xs font-medium text-muted-foreground">
            이웃 새글 수집
          </p>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              수집 기간 (일)
            </span>
            <input
              type="number"
              min={1}
              max={14}
              value={feedLookback}
              onChange={(e) => setFeedLookback(Number(e.target.value) || 3)}
              className="w-20 rounded-md border border-input px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              하루 동일 이웃 최대 글 수
            </span>
            <input
              type="number"
              min={1}
              max={5}
              value={feedMaxPerNeighbor}
              onChange={(e) =>
                setFeedMaxPerNeighbor(Number(e.target.value) || 1)
              }
              className="w-20 rounded-md border border-input px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              하루 최대 새글 수집량
            </span>
            <input
              type="number"
              min={5}
              max={200}
              value={feedMaxCollect}
              onChange={(e) => setFeedMaxCollect(Number(e.target.value) || 50)}
              className="w-20 rounded-md border border-input px-2 py-1 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">
              이웃 새글 자동 수집
            </span>
            <select
              value={feedCollectMode}
              onChange={(e) =>
                setFeedCollectMode(
                  e.target.value as
                    | "manual"
                    | "daily_1"
                    | "daily_2"
                    | "daily_4",
                )
              }
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="manual">수동</option>
              <option value="daily_1">하루 1회</option>
              <option value="daily_2">하루 2회</option>
              <option value="daily_4">하루 4회</option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              Agent Tick(15분 cron)이 기준 시각 이후 자동 수집합니다. 예전에
              저장된 &quot;수동&quot;도 하루 1회로 동작합니다.
            </p>
          </label>
          {feedCollectMode !== "manual" ? (
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-xs text-muted-foreground">
                기준 시각 (KST)
              </span>
              <select
                value={feedCollectHour}
                onChange={(e) =>
                  setFeedCollectHour(Number(e.target.value) || 9)
                }
                className="w-28 rounded-md border border-input px-2 py-1 text-sm"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-xs text-muted-foreground">
              이웃 새글 AI 자동 생성 개수
            </span>
            <select
              value={feedAiAutoCount}
              onChange={(e) =>
                setFeedAiAutoCount(
                  Number(e.target.value) as 5 | 10 | 20,
                )
              }
              className="w-28 rounded-md border border-input px-2 py-1 text-sm"
            >
              <option value={5}>5개</option>
              <option value={10}>10개</option>
              <option value={20}>20개</option>
            </select>
          </label>
          <p className="text-[11px] text-muted-foreground">
            페이지 진입 시 앞에서부터 이만큼만 자동 생성합니다. 나머지는
            카드의 「댓글 초안 생성」또는 상단 「전체 생성」으로 만듭니다.
          </p>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">
              서로이웃 신청 메시지
            </span>
            <textarea
              value={msgTemplate}
              onChange={(e) => setMsgTemplate(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const next = await updateNeighborSettingsAction({
                  keywords: keywordsText
                    .split(/[,，\n]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                  daily_candidate_quota: quota,
                  ai_analyze_max: aiAnalyzeMax,
                  ai_batch_size: aiBatchSize,
                  daily_request_limit: dailyLimit,
                  message: msgTemplate,
                  delay_min_sec: delayMin,
                  delay_max_sec: delayMax,
                  status_check_mode: statusCheckMode,
                  feed_lookback_days: feedLookback,
                  feed_max_per_neighbor_day: feedMaxPerNeighbor,
                  feed_max_collect_day: feedMaxCollect,
                  feed_collect_mode: feedCollectMode,
                  feed_collect_hour: feedCollectHour,
                  feed_ai_auto_count: feedAiAutoCount,
                });
                setSettings(next);
                setAiAnalyzeMax(next.ai_analyze_max);
                setAiBatchSize(next.ai_batch_size);
                setStatusCheckMode(next.status_check_mode);
                setFeedLookback(next.feed_lookback_days);
                setFeedMaxPerNeighbor(next.feed_max_per_neighbor_day);
                setFeedMaxCollect(next.feed_max_collect_day);
                setFeedCollectMode(next.feed_collect_mode);
                setFeedCollectHour(next.feed_collect_hour);
                setFeedAiAutoCount(next.feed_ai_auto_count);
                setMessage("설정을 저장했습니다.");
                router.refresh();
              })
            }
          >
            설정 저장
          </Button>
        </div>
      ) : null}

      {tab === "candidates" && selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-16 z-20 border-t border-border/70 bg-background/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto w-full max-w-lg">
            <Button
              className="w-full"
              disabled={pending || Boolean(flow)}
              onClick={() => void requestBatch([...selected])}
            >
              선택 실행 ({selected.size})
            </Button>
          </div>
        </div>
      ) : null}

      {flow ? (
        <AppModal
          open
          title={
            flow.phase === "confirm"
              ? "실행 확인"
              : flow.phase === "duplicate"
                ? "이미 서로이웃 처리한 블로그"
                : flow.phase === "running"
                  ? "서로이웃 신청 진행"
                  : "서로이웃 신청 완료"
          }
          onClose={() => {
            if (flow.phase === "running") return;
            if (autoCloseRef.current) {
              clearTimeout(autoCloseRef.current);
              autoCloseRef.current = null;
            }
            setFlow(null);
          }}
          showCloseButton={flow.phase !== "running"}
          footer={null}
        >
            {flow.phase === "confirm" ? (
              <>
                <p className="text-sm">
                  {flow.ids.length === 1
                    ? "서로이웃 신청 1건을 진행합니다."
                    : `선택한 ${flow.ids.length}건을 진행합니다.`}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  예상 소요시간: {flow.eta}
                </p>
                {flow.ids.length > 1 ? (
                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                    <li>처리 방식: 순차 처리</li>
                    <li>
                      블로그별 랜덤 대기 {delayMin}~{delayMax}초
                    </li>
                    <li>하루 신청 제한 적용</li>
                  </ul>
                ) : null}
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => setFlow(null)}>
                    취소
                  </Button>
                  <Button
                    onClick={() => {
                      const ids = flow.ids;
                      void runBatch(ids);
                    }}
                  >
                    신청 시작
                  </Button>
                </div>
              </>
            ) : null}

            {flow.phase === "duplicate" ? (
              <>
                <h3 className="text-base font-semibold">
                  이미 서로이웃 처리한 블로그입니다.
                </h3>
                <ul className="mt-3 max-h-40 space-y-2 overflow-y-auto text-sm">
                  {flow.duplicates.map((d) => (
                    <li key={d.personId}>
                      {d.blogName} ({d.blogId})
                    </li>
                  ))}
                </ul>
                <div className="mt-5 flex flex-col gap-2">
                  <Button
                    onClick={() => {
                      const dup = new Set(
                        flow.duplicates.map((d) => d.personId),
                      );
                      const remaining = flow.ids.filter((id) => !dup.has(id));
                      if (remaining.length === 0) {
                        setFlow(null);
                        return;
                      }
                      setFlow({
                        phase: "confirm",
                        ids: remaining,
                        eta: formatEta(remaining.length, delayMin, delayMax),
                      });
                    }}
                  >
                    제외하고 진행
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      setFlow({
                        phase: "confirm",
                        ids: flow.ids,
                        eta: formatEta(flow.ids.length, delayMin, delayMax),
                      })
                    }
                  >
                    그래도 실행
                  </Button>
                  <Button variant="ghost" onClick={() => setFlow(null)}>
                    취소
                  </Button>
                </div>
              </>
            ) : null}

            {flow.phase === "running" ? (
              <>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">전체</dt>
                    <dd>{flow.total}건</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">현재 처리</dt>
                    <dd>
                      {flow.current} / {flow.total}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">성공</dt>
                    <dd>{flow.success}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">실패</dt>
                    <dd>{flow.failed}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">대기</dt>
                    <dd>{flow.waiting}</dd>
                  </div>
                </dl>
                <div className="mt-4 rounded-lg bg-secondary/60 px-3 py-3 text-sm">
                  <p className="text-xs text-muted-foreground">현재 처리 중</p>
                  <p className="mt-1 font-medium">{flow.title}</p>
                  <p className="mt-2 text-xs">
                    상태: {statusDisplay(flow.statusKind)}
                  </p>
                </div>
                {flow.nextDelaySec != null && flow.statusKind === "waiting" ? (
                  <p className="mt-3 text-center text-sm text-muted-foreground">
                    다음 작업까지 약 {flow.nextDelaySec}초
                  </p>
                ) : null}
                <div className="mt-5 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setFlow(null)}
                  >
                    닫기
                  </Button>
                </div>
              </>
            ) : null}

            {flow.phase === "done" ? (
              <>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt>총</dt>
                    <dd>{flow.total}건</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>성공</dt>
                    <dd>{flow.success}건</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>실패</dt>
                    <dd>{flow.failed}건</dd>
                  </div>
                </dl>
                <div className="mt-5 flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (autoCloseRef.current) {
                        clearTimeout(autoCloseRef.current);
                        autoCloseRef.current = null;
                      }
                      setFlow(null);
                    }}
                  >
                    닫기
                  </Button>
                  <Button
                    onClick={() => {
                      if (autoCloseRef.current) {
                        clearTimeout(autoCloseRef.current);
                        autoCloseRef.current = null;
                      }
                      setFlow(null);
                      if (flow.success > 0) goToCompletedTab();
                    }}
                  >
                    확인
                  </Button>
                </div>
              </>
            ) : null}
        </AppModal>
      ) : null}

      {failModal ? (
        <AppModal
          open
          title={toFriendlyFailure(failModal.raw, "neighbor_request").headline}
          onClose={() => setFailModal(null)}
        >
          {(() => {
            const friendly = toFriendlyFailure(
              failModal.raw,
              "neighbor_request",
            );
            return (
              <>
                <p className="text-xs text-muted-foreground">{failModal.name}</p>
                <p className="mt-3 text-sm">{friendly.cause}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {friendly.detail}
                </p>
              </>
            );
          })()}
        </AppModal>
      ) : null}
    </div>
  );
}
