"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  getNeighborManageDetailAction,
  listAcceptedNeighborManageAction,
} from "@/app/actions/neighbors";
import { NeighborManageDetail } from "@/components/neighbor/NeighborManageDetail";
import { NeighborManageList } from "@/components/neighbor/NeighborManageList";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  NeighborManageDetailView,
  NeighborManageListItem,
  NeighborManageTodayActions,
  NeighborManageWeeklyReport,
} from "@/types/neighborManage";
import { emptyNeighborWeeklyReport } from "@/lib/neighborManageListUtils";

const DETAIL_NOT_FOUND_MESSAGE =
  "이웃 정보를 찾을 수 없거나, 서로이웃 완료 상태가 아닙니다.";

function buildManageUrl(pathname: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function NeighborManagePanel() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("id")?.trim() || null;

  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [items, setItems] = useState<NeighborManageListItem[]>([]);
  const [todayActions, setTodayActions] = useState<NeighborManageTodayActions>({
    visit: 0,
    like: 0,
    comment: 0,
  });
  const [weeklyReport, setWeeklyReport] = useState<NeighborManageWeeklyReport>(
    () => emptyNeighborWeeklyReport(),
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<NeighborManageDetailView | null>(null);

  const replaceManageParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", "manage");
      mutate(params);
      router.replace(buildManageUrl(pathname, params), { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const selectPerson = useCallback(
    (personId: string) => {
      replaceManageParams((params) => {
        params.set("id", personId);
      });
    },
    [replaceManageParams],
  );

  const clearSelection = useCallback(() => {
    replaceManageParams((params) => {
      params.delete("id");
    });
  }, [replaceManageParams]);

  const reloadList = useCallback(async () => {
    const payload = await listAcceptedNeighborManageAction();
    setItems(payload.items);
    setTodayActions(payload.todayActions);
    setWeeklyReport(payload.weeklyReport);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    void listAcceptedNeighborManageAction()
      .then((payload) => {
        if (!cancelled) {
          setItems(payload.items);
          setTodayActions(payload.todayActions);
          setWeeklyReport(payload.weeklyReport);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setListError(
            err instanceof Error
              ? err.message
              : "이웃 목록을 불러오지 못했습니다.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void getNeighborManageDetailAction(selectedId)
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setDetailError(DETAIL_NOT_FOUND_MESSAGE);
          setDetail(null);
          return;
        }
        setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetailError(
            err instanceof Error
              ? err.message
              : "상세 정보를 불러오지 못했습니다.",
          );
          setDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (selectedId) {
    if (detailLoading) {
      return (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      );
    }
    if (detailError || !detail) {
      return (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={clearSelection}
            className="text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            ← 이웃 목록
          </button>
          <p className="rounded-xl border border-border/70 bg-card px-4 py-3 text-sm text-muted-foreground">
            {detailError ?? DETAIL_NOT_FOUND_MESSAGE}
          </p>
        </div>
      );
    }
    return (
      <NeighborManageDetail data={detail} onBack={clearSelection} />
    );
  }

  if (listLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }

  if (listError) {
    return (
      <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {listError}
      </p>
    );
  }

  return (
    <NeighborManageList
      items={items}
      todayActions={todayActions}
      weeklyReport={weeklyReport}
      onSelect={selectPerson}
      onListRefresh={reloadList}
    />
  );
}
