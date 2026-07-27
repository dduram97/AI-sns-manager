import { AdminNeighborsScreen } from "@/components/admin/AdminNeighborsScreen";
import { getAdminNeighborsScreenData } from "@/services/adminNeighborPerformanceService";

export const dynamic = "force-dynamic";

export default async function AdminNeighborsPage() {
  const data = await getAdminNeighborsScreenData();
  return <AdminNeighborsScreen data={data} />;
}
