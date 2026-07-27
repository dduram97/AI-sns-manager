"use client";

import { useEffect, useState } from "react";
import {
  getNeighborFeedStatusAction,
  listNeighborFeedPoolAction,
  logNeighborFeedApprovalsCreatedAction,
  prepareNeighborFeedCollectAction,
  registerNeighborFeedApprovalsBatchAction,
  scanNeighborFeedBatchAction,
  stampNeighborFeedCollectAtAction,
} from "@/app/actions/neighbors";
import { NeighborExistingSyncControls } from "@/components/neighbor/NeighborExistingSyncControls";
import { NeighborFeedApprovalInbox } from "@/components/neighbor/NeighborFeedApprovalInbox";
import { Button } from "@/components/ui/button";
import { feedCollectModeLabel } from "@/domain/neighbor/feedSchedule";
import {
  CDP_FALLBACK_MAX,
  emptyExcludes,
  FEED_REGISTER_BATCH_SIZE,
  FEED_REGISTER_CONCURRENCY,
  FEED_SCAN_BATCH_SIZE,
  mergeExcludes,
  RSS_CONCURRENCY,
  sumExcludes,
  type NeighborFeedCollectResult,
  type NeighborFeedPoolMember,
  type NeighborFeedScanBatchResult,
} from "@/domain/neighbor/feedTypes";
import { formatApprovalFailureTime } from "@/lib/approvalFailure";

function formatEtaSec(sec: number): string {
  if (sec < 5) return "곧 완료";
  if (sec < 60) return `약 ${Math.max(5, Math.round(sec / 5) * 5)}초`;
  const m = Math.ceil(sec / 60);
  return `약 ${m}분`;
}

function estimateScanRemainingSec(
  remaining: number,
  cdpBudgetLeft: number,
): number {
  const rssWaves = Math.ceil(Math.max(0, remaining) / RSS_CONCURRENCY);
  const rssSec = rssWaves * 0.9;
  const cdpLikely = Math.min(cdpBudgetLeft, Math.ceil(remaining * 0.08));
  return rssSec + cdpLikely * 2.2;
}

function estimateRegisterRemainingSec(remaining: number): number {
  const waves = Math.ceil(Math.max(0, remaining) / FEED_REGISTER_CONCURRENCY);
  return waves * 0.35;
}

type ProgressState =
  | {
      phase: "scanning";
      total: number;
      checked: number;
      found: number;
      excluded: number;
      currentName: string;
      etaLabel: string;
    }
  | {
      phase: "creating";
      total: number;
      done: number;
      created: number;
      duplicateExcluded: number;
      failed: number;
      currentName: string;
      currentTitle: string;
      etaLabel: string;
    };

export function NeighborFeedPanel({
  initialLastCollectAt,
  initialPoolHint,
}: {
  initialLastCollectAt: string | null;
  initialPoolHint?: number;
}) {
  const [status, setStatus] = useState<{
    poolSize: number;
    lastCollectAt: string | null;
    lookbackDays: number;
    maxPerNeighborDay: number;
    maxCollectDay: number;
    collectMode?: "manual" | "daily_1" | "daily_2" | "daily_4";
    collectHour?: number;
    hasNeighborRecords?: boolean;
    feedAiAutoCount?: 5 | 10 | 20;
  } | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<NeighborFeedCollectResult | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [inboxKey, setInboxKey] = useState(0);
  const [statusError, setStatusError] = useState(false);
  const collecting = progress != null;

  useEffect(() => {
    void getNeighborFeedStatusAction()
      .then((s) => {
        setStatus(s);
        setStatusError(false);
      })
      .catch(() => {
        setStatusError(true);
      });
  }, []);

  const poolSize = status?.poolSize ?? initialPoolHint ?? 0;
  const lastAt = status?.lastCollectAt ?? initialLastCollectAt;

  async function runCollect() {
    setResult(null);
    setMessage(null);
    setShowDetail(false);
    setStatusError(false);

    try {
      // Light reconcile + pool refresh before scan
      const pool = await listNeighborFeedPoolAction();
      const nextStatus = await getNeighborFeedStatusAction();
      setStatus(nextStatus);
      const total = pool.length;
      if (total === 0) {
        setMessage(
          nextStatus.hasNeighborRecords
            ? "수집 대상 이웃이 없습니다. 제외 목록·서로이웃 상태를 확인해 주세요."
            : "처음 사용하는 경우 기존 이웃 불러오기를 진행해주세요.",
        );
        return;
      }

      let checked = 0;
      let postsSeen = 0;
      let found = 0;
      let excludedAcc = emptyExcludes();
      const sourceStats = { rss: 0, cdp: 0, fail: 0 };
      const allCandidates: NeighborFeedScanBatchResult["candidates"] = [];
      let cdpBudget = CDP_FALLBACK_MAX;

      setProgress({
        phase: "scanning",
        total,
        checked: 0,
        found: 0,
        excluded: 0,
        currentName: pool[0]?.blogName ?? "—",
        etaLabel: formatEtaSec(estimateScanRemainingSec(total, cdpBudget)),
      });

      for (let i = 0; i < pool.length; i += FEED_SCAN_BATCH_SIZE) {
        const chunk: NeighborFeedPoolMember[] = pool.slice(
          i,
          i + FEED_SCAN_BATCH_SIZE,
        );
        setProgress({
          phase: "scanning",
          total,
          checked,
          found,
          excluded: sumExcludes(excludedAcc),
          currentName: chunk[0]?.blogName ?? "—",
          etaLabel: formatEtaSec(
            estimateScanRemainingSec(total - checked, cdpBudget),
          ),
        });

        const scan = await scanNeighborFeedBatchAction({
          members: chunk,
          cdpBudget,
        });

        cdpBudget = Math.max(0, cdpBudget - scan.sourceStats.cdp);
        checked += scan.checked;
        postsSeen += scan.postsSeen;
        excludedAcc = mergeExcludes(excludedAcc, scan.excluded);
        sourceStats.rss += scan.sourceStats.rss;
        sourceStats.cdp += scan.sourceStats.cdp;
        sourceStats.fail += scan.sourceStats.fail;
        allCandidates.push(...scan.candidates);
        found = allCandidates.length;

        const lastInChunk = chunk[chunk.length - 1];
        setProgress({
          phase: "scanning",
          total,
          checked,
          found,
          excluded: sumExcludes(excludedAcc),
          currentName: lastInChunk?.blogName ?? "—",
          etaLabel: formatEtaSec(
            estimateScanRemainingSec(total - checked, cdpBudget),
          ),
        });
      }

      const prepared = await prepareNeighborFeedCollectAction({
        candidates: allCandidates,
        poolSize: total,
        postsSeen,
        excluded: excludedAcc,
        sourceStats,
      });

      const toCreate = prepared.toCreate;
      let done = 0;
      let created = 0;
      let duplicateExcluded = prepared.duplicateExcluded;
      let failed = 0;

      setProgress({
        phase: "creating",
        total: toCreate.length,
        done: 0,
        created: 0,
        duplicateExcluded,
        failed: 0,
        currentName: toCreate[0]?.blogName ?? "—",
        currentTitle: toCreate[0]?.post.title ?? "—",
        etaLabel: formatEtaSec(estimateRegisterRemainingSec(toCreate.length)),
      });

      for (let i = 0; i < toCreate.length; i += FEED_REGISTER_BATCH_SIZE) {
        const chunk = toCreate.slice(i, i + FEED_REGISTER_BATCH_SIZE);
        setProgress({
          phase: "creating",
          total: toCreate.length,
          done,
          created,
          duplicateExcluded,
          failed,
          currentName: chunk[0]?.blogName ?? "—",
          currentTitle: chunk[0]?.post.title ?? "—",
          etaLabel: formatEtaSec(
            estimateRegisterRemainingSec(toCreate.length - done),
          ),
        });

        const batch = await registerNeighborFeedApprovalsBatchAction({
          candidates: chunk,
        });
        done += batch.processed;
        created += batch.created;
        failed += batch.failed;
        duplicateExcluded += batch.skippedDuplicate;

        setProgress({
          phase: "creating",
          total: toCreate.length,
          done,
          created,
          duplicateExcluded,
          failed,
          currentName: batch.lastBlogName ?? chunk[chunk.length - 1]?.blogName ?? "—",
          currentTitle:
            batch.lastTitle ?? chunk[chunk.length - 1]?.post.title ?? "—",
          etaLabel: formatEtaSec(
            estimateRegisterRemainingSec(toCreate.length - done),
          ),
        });
      }

      const lastCollectAt = await stampNeighborFeedCollectAtAction();
      const excluded = { ...prepared.excluded };
      excluded.create_failed += failed;

      await logNeighborFeedApprovalsCreatedAction(created);

      const res: NeighborFeedCollectResult = {
        ok: true,
        message:
          created > 0
            ? `이웃 새글 ${created}건을 아래 목록에 추가했습니다.`
            : "조건에 맞는 새글이 없습니다.",
        lastCollectAt,
        poolSize: prepared.poolSize,
        postsSeen: prepared.postsSeen,
        recentFound: prepared.recentFound,
        excluded,
        finalCount: created,
        approvalsCreated: created,
        duplicateExcluded,
        createFailed: failed,
        sourceStats: prepared.sourceStats,
      };

      setResult(res);
      setMessage(res.message);
      setProgress(null);
      setInboxKey((k) => k + 1);
      const next = await getNeighborFeedStatusAction();
      setStatus(next);
    } catch {
      setProgress(null);
      setMessage("새글 수집 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }

  const scheduleLabel =
    status?.collectMode && status.collectMode !== "manual"
      ? `${feedCollectModeLabel(status.collectMode)} · ${String(status.collectHour ?? 9).padStart(2, "0")}:00 KST (Agent Tick 자동)`
      : `하루 1회 · ${String(status?.collectHour ?? 9).padStart(2, "0")}:00 KST (Agent Tick 자동)`;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border/70 bg-card p-4">
        <h2 className="text-sm font-semibold">이웃 새글 수집</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          서로이웃 완료·기존 관리 이웃의 최근{" "}
          {status?.lookbackDays ?? 3}일 글을 RSS로 빠르게 모은 뒤, 필요한
          경우만 CDP로 확인합니다. 블로그당 최신 1개 · 이미 처리한 글 제외.
        </p>
        <dl className="mt-3 space-y-1.5 text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">마지막 수집</dt>
            <dd>{lastAt ? formatApprovalFailureTime(lastAt) : "없음"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">수집 대상 이웃</dt>
            <dd className="font-medium">{poolSize}명</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">하루 수집 한도</dt>
            <dd>
              이웃당 {status?.maxPerNeighborDay ?? 1} · 전체{" "}
              {status?.maxCollectDay ?? 50}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">자동 수집</dt>
            <dd>{scheduleLabel}</dd>
          </div>
        </dl>
        <Button
          className="mt-4 w-full"
          disabled={collecting || poolSize === 0}
          onClick={() => void runCollect()}
        >
          {collecting ? "수집 중…" : "새글 수집 실행"}
        </Button>
        <div className="mt-3 border-t border-border/60 pt-3">
          <NeighborExistingSyncControls
            onDone={() => {
              void getNeighborFeedStatusAction().then(setStatus);
            }}
          />
        </div>
        {statusError ? (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            이웃 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.
          </p>
        ) : poolSize === 0 ? (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            {status?.hasNeighborRecords
              ? "수집 대상 이웃이 없습니다. 제외 목록·서로이웃 상태를 확인해 주세요."
              : "처음 사용하는 경우 기존 이웃 불러오기를 진행해주세요."}
          </p>
        ) : null}
      </div>

      {message && !result ? (
        <p className="text-center text-xs text-muted-foreground">{message}</p>
      ) : null}

      {result ? (
        <div className="rounded-xl border border-border/70 bg-card p-4 text-xs">
          <p className="text-sm font-semibold">이웃 새글 수집 완료</p>
          {message ? (
            <p className="mt-1 text-muted-foreground">{message}</p>
          ) : null}
          <dl className="mt-3 space-y-1.5">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">확인 이웃</dt>
              <dd className="font-medium">{result.poolSize}명</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">새글 발견</dt>
              <dd className="font-medium">{result.recentFound}개</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">신규 등록</dt>
              <dd className="font-semibold">{result.finalCount}개</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">중복 제외</dt>
              <dd>{result.duplicateExcluded}개</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">실패</dt>
              <dd>{result.createFailed}개</dd>
            </div>
          </dl>
          <button
            type="button"
            className="mt-3 text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowDetail((v) => !v)}
          >
            {showDetail ? "상세 접기" : "상세 펼치기"}
          </button>
          {showDetail ? (
            <div className="mt-3 space-y-2 border-t border-border/60 pt-3 text-muted-foreground">
              <p>
                수집 소스 · RSS {result.sourceStats.rss} · CDP{" "}
                {result.sourceStats.cdp} · 실패 {result.sourceStats.fail}
              </p>
              <p>확인한 게시글 수 {result.postsSeen}</p>
              <ul className="space-y-1">
                <li>너무 오래된 글: {result.excluded.too_old}</li>
                <li>이미 처리/대기: {result.excluded.already_handled}</li>
                <li>동일 블로그 중복: {result.excluded.duplicate_blog}</li>
                <li>이웃당 한도: {result.excluded.per_neighbor_cap}</li>
                <li>하루 수집 한도: {result.excluded.daily_cap}</li>
                <li>스크랩 없음: {result.excluded.scrape_empty}</li>
                <li>스크랩 오류: {result.excluded.scrape_error}</li>
                <li>생성 실패: {result.excluded.create_failed}</li>
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {progress ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/45 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-xl">
            {progress.phase === "scanning" ? (
              <>
                <h3 className="text-base font-semibold">이웃 새글 수집 중</h3>
                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">전체 이웃</dt>
                    <dd>{progress.total}명</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">확인 완료</dt>
                    <dd>
                      {progress.checked} / {progress.total}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">새글 발견</dt>
                    <dd>{progress.found}개</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">제외</dt>
                    <dd>{progress.excluded}개</dd>
                  </div>
                </dl>
                <div className="mt-4 rounded-lg bg-secondary/60 px-3 py-3 text-sm">
                  <p className="text-xs text-muted-foreground">현재 확인 중</p>
                  <p className="mt-1 font-medium">{progress.currentName}</p>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-base font-semibold">Approval 등록 중</h3>
                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">전체</dt>
                    <dd>{progress.total}건</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">완료</dt>
                    <dd>
                      {progress.done} / {progress.total}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">생성</dt>
                    <dd>{progress.created}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">중복 제외</dt>
                    <dd>{progress.duplicateExcluded}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">실패</dt>
                    <dd>{progress.failed}</dd>
                  </div>
                </dl>
                <div className="mt-4 rounded-lg bg-secondary/60 px-3 py-3 text-sm">
                  <p className="text-xs text-muted-foreground">현재 처리</p>
                  <p className="mt-1 font-medium">{progress.currentName}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {progress.currentTitle}
                  </p>
                </div>
              </>
            )}
            <p className="mt-3 text-center text-sm text-muted-foreground">
              예상 완료: {progress.etaLabel}
            </p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-foreground/80 transition-all duration-300"
                style={{
                  width: `${
                    progress.phase === "scanning"
                      ? progress.total > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (progress.checked / progress.total) * 100,
                            ),
                          )
                        : 0
                      : progress.total > 0
                        ? Math.min(
                            100,
                            Math.round((progress.done / progress.total) * 100),
                          )
                        : 100
                  }%`,
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-2">
        <h2 className="mb-2 text-sm font-semibold">이웃 새글 관리</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          수집된 글을 선택해 댓글·공감을 실행합니다. 페이지 진입 시 앞에서부터
          자동으로 AI 초안을 만들며, 완료된 카드부터 바로 사용할 수 있습니다.
        </p>
        <NeighborFeedApprovalInbox
          refreshKey={inboxKey}
          autoCount={status?.feedAiAutoCount ?? 5}
        />
      </div>
    </div>
  );
}
