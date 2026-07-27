"use server";

import { unstable_noStore as noStore } from "next/cache";

import { getTodaySummary } from "@/services/getTodaySummary";
import type { TodaySummaryViewModel } from "@/types/todaySummary";

export async function getTodaySummaryAction(): Promise<TodaySummaryViewModel> {
  noStore();
  return getTodaySummary();
}
