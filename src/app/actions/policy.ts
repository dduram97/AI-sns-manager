"use server";

import { revalidatePath } from "next/cache";
import {
  saveAutomationPolicy,
  saveDailyLimits,
  saveDiscoverPolicySettings,
  saveTonePolicy,
  type SaveAutomationInput,
  type SaveDiscoverPolicyInput,
  type SaveLimitsInput,
  type SaveToneInput,
} from "@/services/policyService";

function revalidateMore() {
  revalidatePath("/more");
  revalidatePath("/discover");
  revalidatePath("/today");
}

export async function saveAutomationPolicyAction(input: SaveAutomationInput) {
  await saveAutomationPolicy(input);
  revalidateMore();
}

export async function saveDailyLimitsAction(input: SaveLimitsInput) {
  await saveDailyLimits(input);
  revalidateMore();
}

export async function saveTonePolicyAction(input: SaveToneInput) {
  await saveTonePolicy(input);
  revalidateMore();
}

export async function saveDiscoverPolicyAction(input: SaveDiscoverPolicyInput) {
  await saveDiscoverPolicySettings(input);
  revalidateMore();
}
