import { loadPersonListPage } from "@/services/personService";
import { PersonListScreen } from "@/components/person/PersonListScreen";

export async function PersonListContent() {
  const items = await loadPersonListPage();
  return <PersonListScreen items={items} />;
}
