"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  markDiscoverDismissedAction,
  markDiscoverInterestedAction,
} from "@/app/actions/discover";
import { Button } from "@/components/ui/button";
import type { DiscoverCandidateItem } from "@/types/discover";

export function DiscoverCandidateCard({ item }: { item: DiscoverCandidateItem }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function run(action: () => Promise<void>) {
    start(async () => {
      await action();
      router.refresh();
    });
  }

  return (
    <article className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Agent Candidate · {item.stage}
          </p>
          <h2 className="mt-1 text-base font-semibold tracking-tight">
            <Link
              href={`/people/${item.personId}`}
              className="hover:underline"
            >
              {item.blogName}
            </Link>
          </h2>
          {item.blogId ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {item.blogId}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] font-medium text-muted-foreground">
            예상 관계 가치
          </p>
          <p className="text-lg font-semibold tabular-nums">
            {item.relationshipValue}
          </p>
        </div>
      </div>

      {item.matchedKeywords.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted-foreground">
            키워드 매칭
          </p>
          <p className="mt-1 text-sm text-foreground/85">
            {item.matchedKeywords.join(" · ")}
          </p>
        </div>
      ) : null}

      {item.recommendReasons.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted-foreground">
            추천 이유
          </p>
          <ul className="mt-1.5 space-y-1">
            {item.recommendReasons.map((r) => (
              <li key={r} className="flex gap-2 text-sm text-foreground/85">
                <span className="text-muted-foreground">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.snippet ? (
        <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {item.snippet}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button
          className="w-full"
          disabled={pending}
          onClick={() => run(() => markDiscoverInterestedAction(item.personId))}
        >
          관심 있음
        </Button>
        <Button
          variant="outline"
          className="w-full"
          disabled={pending}
          onClick={() => run(() => markDiscoverDismissedAction(item.personId))}
        >
          관심 없음
        </Button>
      </div>
    </article>
  );
}
