import Link from "next/link";
import { Button } from "@/components/ui/button";

export function ApprovalSummarySection({ count }: { count: number }) {
  const empty = count === 0;
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Approval Inbox
      </h2>
      <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">
        {count}
        <span className="ml-1 text-sm font-normal text-muted-foreground">건 대기</span>
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {empty
          ? "오늘은 결재할 항목이 없습니다. Agent가 저위험을 처리했습니다."
          : "고위험 액션만 승인이 필요합니다."}
      </p>
      {empty ? (
        <Button size="lg" className="mt-4 w-full" disabled>
          승인 시작
        </Button>
      ) : (
        <Button asChild size="lg" className="mt-4 w-full">
          <Link href="/today/approvals">승인 시작</Link>
        </Button>
      )}
    </section>
  );
}
