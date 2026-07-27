"use client";

import { useState } from "react";
import {
  EXISTING_NEIGHBOR_UPSERT_BATCH,
  type ExistingNeighborDto,
  type ExistingNeighborFetchDiagnostics,
  type ExistingNeighborSyncSummary,
} from "@/domain/neighbor/existingSyncTypes";
import { Button } from "@/components/ui/button";
import {
  fetchExistingNeighborsAction,
  finalizeExistingNeighborSyncAction,
  upsertExistingNeighborsBatchAction,
} from "@/app/actions/neighbors";

type ProgressState = {
  phase: "fetching" | "saving";
  total: number;
  checked: number;
  added: number;
  updated: number;
  currentName: string;
  etaLabel: string;
};

function formatEtaSec(sec: number): string {
  if (sec < 5) return "곧 완료";
  if (sec < 60) return `약 ${Math.max(5, Math.round(sec / 5) * 5)}초`;
  return `약 ${Math.ceil(sec / 60)}분`;
}

export function NeighborExistingSyncControls({
  onDone,
}: {
  onDone?: (summary: ExistingNeighborSyncSummary) => void;
}) {
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<ExistingNeighborSyncSummary | null>(
    null,
  );
  const [diagnostics, setDiagnostics] =
    useState<ExistingNeighborFetchDiagnostics | null>(null);
  const [fetchMessage, setFetchMessage] = useState<string | null>(null);
  const [ownBlogId, setOwnBlogId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress != null;

  async function runSync() {
    setError(null);
    setResult(null);
    setDiagnostics(null);
    setFetchMessage(null);
    setOwnBlogId(null);
    setProgress({
      phase: "fetching",
      total: 0,
      checked: 0,
      added: 0,
      updated: 0,
      currentName: "네이버 이웃 목록",
      etaLabel: "목록 수집 중…",
    });

    try {
      const fetched = await fetchExistingNeighborsAction();
      setOwnBlogId(fetched.ownBlogId);
      setDiagnostics(fetched.diagnostics ?? null);
      setFetchMessage(fetched.message);

      if (!fetched.ok) {
        setProgress(null);
        setError(fetched.message);
        return;
      }

      const neighbors: ExistingNeighborDto[] = fetched.neighbors;
      const total = neighbors.length;

      if (total === 0) {
        setProgress(null);
        setResult({
          ok: true,
          message: fetched.message,
          ownBlogId: fetched.ownBlogId,
          total: 0,
          added: 0,
          updated: 0,
          skipped: 0,
          lastSyncAt: fetched.fetchedAt,
          errors: [],
        });
        return;
      }

      let checked = 0;
      let added = 0;
      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];

      setProgress({
        phase: "saving",
        total,
        checked: 0,
        added: 0,
        updated: 0,
        currentName: neighbors[0]?.blogName ?? "—",
        etaLabel: formatEtaSec(
          Math.ceil(total / EXISTING_NEIGHBOR_UPSERT_BATCH) * 1.2,
        ),
      });

      for (let i = 0; i < neighbors.length; i += EXISTING_NEIGHBOR_UPSERT_BATCH) {
        const chunk = neighbors.slice(i, i + EXISTING_NEIGHBOR_UPSERT_BATCH);
        setProgress({
          phase: "saving",
          total,
          checked,
          added,
          updated,
          currentName: chunk[0]?.blogName ?? "—",
          etaLabel: formatEtaSec(
            Math.ceil((total - checked) / EXISTING_NEIGHBOR_UPSERT_BATCH) * 1.2,
          ),
        });

        const batch = await upsertExistingNeighborsBatchAction(chunk);
        checked += batch.processed;
        added += batch.added;
        updated += batch.updated;
        skipped += batch.skipped;
        errors.push(...batch.errors);

        setProgress({
          phase: "saving",
          total,
          checked,
          added,
          updated,
          currentName:
            batch.lastName ?? chunk[chunk.length - 1]?.blogName ?? "—",
          etaLabel: formatEtaSec(
            Math.ceil((total - checked) / EXISTING_NEIGHBOR_UPSERT_BATCH) * 1.2,
          ),
        });
      }

      const summary = await finalizeExistingNeighborSyncAction({
        ownBlogId: fetched.ownBlogId,
        total,
        added,
        updated,
        skipped,
        errors,
      });

      setResult(summary);
      setProgress(null);
      onDone?.(summary);
    } catch (err) {
      setProgress(null);
      setError(
        err instanceof Error
          ? err.message
          : "기존 이웃 동기화 중 오류가 발생했습니다.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={busy}
        onClick={() => void runSync()}
      >
        {busy ? "불러오는 중…" : "기존 이웃 불러오기"}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        로그인된 네이버 계정의 이웃 목록을 DB에 동기화합니다. 블로그 ID가 로그인
        ID와 다르면 .env에 NAVER_BLOG_ID를 설정하세요.
      </p>

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}

      {result || diagnostics ? (
        <div className="rounded-xl border border-border/70 bg-card p-3 text-xs">
          <p className="text-sm font-semibold">
            {result && result.total > 0 ? "동기화 완료" : "수집 결과"}
          </p>
          {fetchMessage ? (
            <p className="mt-1 text-muted-foreground">{fetchMessage}</p>
          ) : result ? (
            <p className="mt-1 text-muted-foreground">{result.message}</p>
          ) : null}

          <dl className="mt-2 space-y-1">
            {ownBlogId ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">내 블로그 ID</dt>
                <dd className="font-medium">{ownBlogId}</dd>
              </div>
            ) : null}
            {diagnostics ? (
              <>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">ID 출처</dt>
                  <dd>{diagnostics.ownBlogIdSource}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">로그인</dt>
                  <dd>
                    {diagnostics.loginOk ? "확인 성공" : "권한/로그인 필요"}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">후보 element</dt>
                  <dd>{diagnostics.candidateElements}개</dd>
                </div>
              </>
            ) : null}
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">전체 확인</dt>
              <dd>{result?.total ?? 0}명</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">신규 등록</dt>
              <dd>{result?.added ?? 0}명</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">업데이트</dt>
              <dd>{result?.updated ?? 0}명</dd>
            </div>
          </dl>

          {diagnostics?.checklist?.length ? (
            <ul className="mt-3 space-y-1 border-t border-border/60 pt-2">
              {diagnostics.checklist.map((line) => (
                <li key={line} className="text-foreground/90">
                  {line}
                </li>
              ))}
            </ul>
          ) : diagnostics?.reasons?.length ? (
            <ul className="mt-3 space-y-1 border-t border-border/60 pt-2 text-muted-foreground">
              {diagnostics.reasons.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
          ) : null}

          {diagnostics?.pageAccessSummary?.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-muted-foreground">
                페이지 상세
              </summary>
              <ul className="mt-1 space-y-1 break-all text-[10px] text-muted-foreground">
                {diagnostics.pageAccessSummary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          ) : null}

          {result && result.errors.length > 0 ? (
            <p className="mt-2 text-muted-foreground">
              일부 오류 {result.errors.length}건 (서버 로그 참고)
            </p>
          ) : null}
        </div>
      ) : null}

      {progress ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/45 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-xl">
            <h3 className="text-base font-semibold">
              {progress.phase === "fetching"
                ? "네이버 이웃 목록 수집 중"
                : "기존 이웃 불러오는 중"}
            </h3>
            {progress.phase === "fetching" ? (
              <p className="mt-3 text-sm text-muted-foreground">
                CDP로 내 블로그 ID를 확인한 뒤 BuddyList를 읽습니다. 이웃이
                많으면 1~2분 걸릴 수 있습니다.
              </p>
            ) : (
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">전체 확인</dt>
                  <dd>
                    {progress.checked} / {progress.total}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">신규 등록</dt>
                  <dd>{progress.added}명</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">업데이트</dt>
                  <dd>{progress.updated}명</dd>
                </div>
              </dl>
            )}
            <div className="mt-4 rounded-lg bg-secondary/60 px-3 py-3 text-sm">
              <p className="text-xs text-muted-foreground">현재 확인</p>
              <p className="mt-1 font-medium">{progress.currentName}</p>
            </div>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              예상 완료: {progress.etaLabel}
            </p>
            {progress.phase === "saving" && progress.total > 0 ? (
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-foreground/80 transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round((progress.checked / progress.total) * 100),
                    )}%`,
                  }}
                />
              </div>
            ) : (
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground/50" />
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
