"use server";

import { revalidatePath } from "next/cache";
import {
  markDiscoverDismissed,
  markDiscoverInterested,
} from "@/services/discoverService";

function revalidateDiscoverPaths(personId?: string) {
  revalidatePath("/discover");
  revalidatePath("/people");
  revalidatePath("/today");
  if (personId) revalidatePath(`/people/${personId}`);
}

export async function markDiscoverInterestedAction(personId: string) {
  await markDiscoverInterested(personId);
  revalidateDiscoverPaths(personId);
}

export async function markDiscoverDismissedAction(personId: string) {
  await markDiscoverDismissed(personId);
  revalidateDiscoverPaths(personId);
}
