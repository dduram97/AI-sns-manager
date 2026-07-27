import { AdminActionsScreen } from "@/components/admin/AdminActionsScreen";
import { getAdminActionsScreenData } from "@/services/adminActionsService";

export const dynamic = "force-dynamic";

export default async function AdminActionsPage() {
  const data = await getAdminActionsScreenData();
  return <AdminActionsScreen data={data} />;
}
