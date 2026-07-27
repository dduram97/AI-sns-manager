import Link from "next/link";

/** Sync shell — renders immediately without awaiting data. */
export function NeighborPageHeader({
  quotaHint,
}: {
  quotaHint?: string | null;
}) {
  return (
    <header className="space-y-2">
      <Link
        href="/today"
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        ← Agent Brief
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">서로이웃 관리</h1>
      <p className="text-sm text-muted-foreground">
        {quotaHint ?? "오늘 사용량 불러오는 중…"}
      </p>
    </header>
  );
}
