import { AdminDiscoveryScreen } from "@/components/admin/AdminDiscoveryScreen";
import { getAdminDiscoveryScreenData } from "@/services/adminDiscoveryService";

export const dynamic = "force-dynamic";

export default async function AdminDiscoveryPage() {
  const data = await getAdminDiscoveryScreenData();
  return <AdminDiscoveryScreen data={data} />;
}
