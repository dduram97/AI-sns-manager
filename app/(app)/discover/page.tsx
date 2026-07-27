import { DiscoverScreen } from "@/components/discover/DiscoverScreen";
import { getDiscoverScreenData } from "@/services/discoverService";

export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  const data = await getDiscoverScreenData();
  return <DiscoverScreen data={data} />;
}
