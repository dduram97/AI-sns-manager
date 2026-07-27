"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  saveAutomationPolicyAction,
  saveDailyLimitsAction,
  saveDiscoverPolicyAction,
  saveTonePolicyAction,
} from "@/app/actions/policy";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MoreScreenData } from "@/types/moreScreen";

function linesToList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One comment example per line (commas inside comments are kept). */
function linesOnlyList(text: string): string[] {
  return text
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function listToLines(items: string[]): string {
  return items.join("\n");
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  lockedLabel,
}: {
  label: string;
  description: string;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  lockedLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {lockedLabel ? (
        <span className="shrink-0 rounded-md bg-secondary px-2.5 py-1 text-[11px] font-medium">
          {lockedLabel}
        </span>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onChange?.(!checked)}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
            checked ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`absolute top-0.5 h-6 w-6 rounded-full bg-background shadow transition-transform ${
              checked ? "left-5" : "left-0.5"
            }`}
          />
        </button>
      )}
    </div>
  );
}

export function MoreScreen({ data }: { data: MoreScreenData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hint, setHint] = useState<string | null>(null);

  const [visitAuto, setVisitAuto] = useState(data.automation.visitAuto);
  const [likeAuto, setLikeAuto] = useState(data.automation.likeAuto);

  const [visitLimit, setVisitLimit] = useState(
    String(data.limits.visit ?? ""),
  );
  const [likeLimit, setLikeLimit] = useState(String(data.limits.like ?? ""));
  const [commentLimit, setCommentLimit] = useState(
    String(data.limits.comment ?? ""),
  );
  const [requestLimit, setRequestLimit] = useState(
    String(data.limits.neighbor_request ?? ""),
  );

  const [toneBase, setToneBase] = useState(data.tone.base);
  const [preferred, setPreferred] = useState(
    listToLines(data.tone.preferredPhrases),
  );
  const [banned, setBanned] = useState(listToLines(data.tone.bannedPhrases));
  const [commentExamples, setCommentExamples] = useState(
    listToLines(data.tone.commentExamples),
  );

  const [keywords, setKeywords] = useState(
    listToLines(data.discover.search_keywords),
  );
  const [goalLabel, setGoalLabel] = useState(data.discover.goal_label ?? "");
  const [discoverActive, setDiscoverActive] = useState(data.discover.active);

  function run(label: string, action: () => Promise<void>) {
    start(async () => {
      setHint(null);
      await action();
      setHint(label);
      router.refresh();
    });
  }

  const parseLimit = (raw: string): number | null => {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5 px-4 pb-28 pt-6">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Supervisor
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">더보기</h1>
        <p className="text-sm text-muted-foreground">
          Agent Policy로 자동화·한도·톤·발굴을 조정합니다.
        </p>
      </header>

      {hint ? (
        <p className="text-center text-xs text-muted-foreground">{hint}</p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Link
          href="/neighbors"
          className="rounded-xl border border-border/70 bg-card px-4 py-3 text-sm font-medium hover:bg-secondary/40"
        >
          서로이웃 관리 →
        </Link>
        <Link
          href="/discover"
          className="rounded-xl border border-border/70 bg-card px-4 py-3 text-sm font-medium hover:bg-secondary/40"
        >
          Agent 발굴 검토 →
        </Link>
      </div>

      {/* A. Agent Policy */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Policy</CardTitle>
          <p className="text-base font-semibold text-foreground">자동화 상태</p>
          <p className="text-xs text-muted-foreground">
            preset {data.automation.preset} · 저위험{" "}
            {visitAuto || likeAuto ? "부분/전체 자동" : "OFF"} · 고위험 Approval
          </p>
        </CardHeader>
        <CardContent>
          <ToggleRow
            label="방문"
            description="저위험 · Policy 한도로 제한"
            checked={visitAuto}
            onChange={setVisitAuto}
          />
          <ToggleRow
            label="공감"
            description="저위험 · Policy 한도로 제한"
            checked={likeAuto}
            onChange={setLikeAuto}
          />
          <ToggleRow
            label="댓글"
            description="고위험 · Supervisor Approval"
            lockedLabel="Approval 필요"
          />
          <ToggleRow
            label="서로이웃 신청"
            description="고위험 · Supervisor Approval"
            lockedLabel="Approval 필요"
          />
          <Button
            className="mt-4 w-full"
            disabled={pending}
            onClick={() =>
              run("자동화 정책 저장됨", () =>
                saveAutomationPolicyAction({ visitAuto, likeAuto }),
              )
            }
          >
            자동화 저장
          </Button>
        </CardContent>
      </Card>

      {/* B. Limits */}
      <Card>
        <CardHeader>
          <CardTitle>실행 한도</CardTitle>
          <p className="text-base font-semibold text-foreground">일일 제한</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {(
            [
              ["방문", visitLimit, setVisitLimit],
              ["공감", likeLimit, setLikeLimit],
              ["댓글", commentLimit, setCommentLimit],
              ["서로이웃 신청", requestLimit, setRequestLimit],
            ] as const
          ).map(([label, value, setValue]) => (
            <label key={label} className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                일일 {label} 제한
              </span>
              <input
                type="number"
                min={0}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="비우면 미설정"
                className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          ))}
          <Button
            className="w-full"
            disabled={pending}
            onClick={() =>
              run("실행 한도 저장됨", () =>
                saveDailyLimitsAction({
                  visit: parseLimit(visitLimit),
                  like: parseLimit(likeLimit),
                  comment: parseLimit(commentLimit),
                  neighbor_request: parseLimit(requestLimit),
                }),
              )
            }
          >
            한도 저장
          </Button>
        </CardContent>
      </Card>

      {/* C. Tone */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Tone</CardTitle>
          <p className="text-base font-semibold text-foreground">말투 · 표현</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              기본 톤
            </span>
            <input
              value={toneBase}
              onChange={(e) => setToneBase(e.target.value)}
              placeholder="예: 따뜻하고 짧은 존댓말"
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              선호 표현 (줄 또는 쉼표)
            </span>
            <textarea
              value={preferred}
              onChange={(e) => setPreferred(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              금지어
            </span>
            <textarea
              value={banned}
              onChange={(e) => setBanned(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <Button
            className="w-full"
            disabled={pending}
            onClick={() =>
              run("톤 정책 저장됨", () =>
                saveTonePolicyAction({
                  base: toneBase,
                  preferredPhrases: linesToList(preferred),
                  bannedPhrases: linesToList(banned),
                  commentExamples: linesOnlyList(commentExamples),
                }),
              )
            }
          >
            톤 저장
          </Button>
        </CardContent>
      </Card>

      {/* C2. Comment style examples */}
      <Card>
        <CardHeader>
          <CardTitle>Comment Style</CardTitle>
          <p className="text-base font-semibold text-foreground">
            내 댓글 스타일 관리
          </p>
          <p className="text-xs text-muted-foreground">
            실제로 쓴 네이버 댓글을 한 줄에 하나씩 저장하면, AI 초안이 이
            말투를 참고합니다.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              내 댓글 예시 ({linesOnlyList(commentExamples).length}개)
            </span>
            <textarea
              value={commentExamples}
              onChange={(e) => setCommentExamples(e.target.value)}
              rows={10}
              placeholder={
                "헤헤 감사합니당 🥰🥰\n오 좋은 아이디어인데용~🌝\n…"
              }
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <Button
            className="w-full"
            disabled={pending}
            onClick={() =>
              run("댓글 스타일 저장됨", () =>
                saveTonePolicyAction({
                  base: toneBase,
                  preferredPhrases: linesToList(preferred),
                  bannedPhrases: linesToList(banned),
                  commentExamples: linesOnlyList(commentExamples),
                }),
              )
            }
          >
            댓글 스타일 저장
          </Button>
        </CardContent>
      </Card>

      {/* D. Discover */}
      <Card>
        <CardHeader>
          <CardTitle>Discover Policy</CardTitle>
          <p className="text-base font-semibold text-foreground">발굴 기준</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            label="활성 여부"
            description="Agent Tick Discover ingest"
            checked={discoverActive}
            onChange={setDiscoverActive}
          />
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              발굴 키워드
            </span>
            <textarea
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              rows={3}
              placeholder="한 줄에 하나 또는 쉼표 구분"
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              주간 목표
            </span>
            <input
              value={goalLabel}
              onChange={(e) => setGoalLabel(e.target.value)}
              placeholder="예: 맛집 블로거 관계 5명"
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <Button
            className="w-full"
            disabled={pending}
            onClick={() =>
              run("Discover Policy 저장됨", () =>
                saveDiscoverPolicyAction({
                  search_keywords: linesToList(keywords),
                  goal_label: goalLabel,
                  active: discoverActive,
                  exclude_keywords: data.discover.exclude_keywords,
                  max_candidates_per_tick: data.discover.max_candidates_per_tick,
                }),
              )
            }
          >
            발굴 정책 저장
          </Button>
        </CardContent>
      </Card>

      {/* E. Agent Execution Log */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Execution Log</CardTitle>
          <p className="text-base font-semibold text-foreground">
            Agent 실행 감독
          </p>
          <p className="text-xs text-muted-foreground">
            최근 Tick과 Action 실행을 확인합니다.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              최근 Tick
            </p>
            {data.executionLog.recentTick ? (
              <div className="rounded-lg border border-border/60 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {data.executionLog.recentTick.timeLabel}
                  </p>
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {data.executionLog.recentTick.ok ? "ok" : "error"}
                    {data.executionLog.recentTick.sourceLabel
                      ? ` · ${data.executionLog.recentTick.sourceLabel}`
                      : ""}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">처리 건수</dt>
                    <dd className="font-medium tabular-nums">
                      {data.executionLog.recentTick.perceptionsProcessed}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Approval 생성</dt>
                    <dd className="font-medium tabular-nums">
                      {data.executionLog.recentTick.approvalsCreated}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Action 실행</dt>
                    <dd className="font-medium tabular-nums">
                      {data.executionLog.recentTick.actionsExecuted}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">실패</dt>
                    <dd className="font-medium tabular-nums">
                      {data.executionLog.recentTick.actionsFailed}
                    </dd>
                  </div>
                </dl>
                {data.executionLog.recentTick.error ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {data.executionLog.recentTick.error}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                아직 기록된 Tick이 없습니다.
              </p>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              최근 실행
            </p>
            {data.executionLog.recentExecutions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                최근 방문·공감·댓글·서로이웃 실행이 없습니다.
              </p>
            ) : (
              <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
                {data.executionLog.recentExecutions.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-start justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {row.actionLabel}
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · {row.personLabel}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {row.timeLabel}
                        {row.error ? ` · ${row.error}` : ""}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                        row.status === "executed"
                          ? "bg-secondary text-foreground"
                          : row.status === "failed"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {row.statusLabel}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* F. Channels */}
      <Card>
        <CardHeader>
          <CardTitle>Channel Connection</CardTitle>
          <p className="text-base font-semibold text-foreground">채널 상태</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.channels.map((ch) => (
            <div
              key={ch.channel}
              className="rounded-lg border border-border/60 px-3 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{ch.label}</p>
                <span className="text-[11px] font-medium text-muted-foreground">
                  {ch.statusLabel}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{ch.readyHint}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
