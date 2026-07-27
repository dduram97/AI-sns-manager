import { notFound } from "next/navigation";
import { PersonDetailScreen } from "@/components/person/PersonDetailScreen";
import { getPersonDetail } from "@/services/personService";

export const dynamic = "force-dynamic";

export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getPersonDetail(id);
  if (!data) notFound();
  return <PersonDetailScreen data={data} />;
}
