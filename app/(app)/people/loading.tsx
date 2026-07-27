import { PersonListHeader } from "@/components/person/PersonListHeader";
import { PersonListSkeleton } from "@/components/person/PersonListSkeleton";

export default function PeopleLoading() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-28 pt-6">
      <PersonListHeader />
      <PersonListSkeleton />
    </div>
  );
}
