import { Suspense } from "react";
import { PersonListHeader } from "@/components/person/PersonListHeader";
import { PersonListContent } from "@/components/person/PersonListContent";
import { PersonListSkeleton } from "@/components/person/PersonListSkeleton";

export const dynamic = "force-dynamic";

export default function PeoplePage() {
  return (
    <>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-28 pt-6">
        <PersonListHeader />
        <Suspense fallback={<PersonListSkeleton />}>
          <PersonListContent />
        </Suspense>
      </div>
    </>
  );
}
