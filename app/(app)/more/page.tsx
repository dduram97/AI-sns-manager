import { MoreScreen } from "@/components/more/MoreScreen";
import { getMoreScreenData } from "@/services/policyService";

export const dynamic = "force-dynamic";

export default async function MorePage() {
  const data = await getMoreScreenData();
  return <MoreScreen data={data} />;
}
