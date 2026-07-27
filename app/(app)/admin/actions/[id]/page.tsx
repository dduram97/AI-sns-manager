import Link from "next/link";
import { AdminActionDetailScreen } from "@/components/admin/AdminActionDetailScreen";
import { getAdminActionDetail } from "@/services/adminNeighborPerformanceService";

export const dynamic = "force-dynamic";

export default async function AdminActionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getAdminActionDetail(id);
  if (!data) {
    return (
      <div className="mx-auto max-w-lg px-4 py-10 text-center text-sm text-muted-foreground">
        job을 찾을 수 없습니다.
        <div className="mt-3">
          <Link href="/admin/actions" className="text-primary underline">
            목록으로
          </Link>
        </div>
      </div>
    );
  }
  return <AdminActionDetailScreen data={data} />;
}
