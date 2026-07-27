"use server";

import { revalidatePath } from "next/cache";
import {
  approveAdminActionJob,
  excludeAdminDiscoveryCandidate,
  getAdminDiscoveryScreenData,
} from "@/services/adminDiscoveryService";
import { getAdminActionsScreenData } from "@/services/adminActionsService";
import {
  getAdminActionDetail,
  getAdminNeighborsScreenData,
  refreshNeighborPerformanceFromMeta,
} from "@/services/adminNeighborPerformanceService";

function revalidateAdminPaths() {
  revalidatePath("/admin/discovery");
  revalidatePath("/admin/actions");
  revalidatePath("/admin/neighbors");
}

export async function loadAdminDiscoveryAction() {
  return getAdminDiscoveryScreenData();
}

export async function loadAdminActionsAction() {
  return getAdminActionsScreenData();
}

export async function loadAdminNeighborsAction() {
  return getAdminNeighborsScreenData();
}

export async function loadAdminActionDetailAction(jobId: string) {
  return getAdminActionDetail(jobId);
}

export async function approveAdminJobAction(
  jobId: string,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const result = await approveAdminActionJob({
    jobId,
    approvedBy: "admin_ui",
  });
  revalidateAdminPaths();
  return result;
}

export async function excludeAdminCandidateAction(input: {
  candidateId: string;
  blogId: string;
  blogUrl?: string | null;
  blogName?: string | null;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const result = await excludeAdminDiscoveryCandidate(input);
  revalidateAdminPaths();
  return result;
}

export async function approveAdminJobsBatchAction(
  jobIds: string[],
): Promise<{ ok: number; failed: number; errors: string[] }> {
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const id of jobIds) {
    const r = await approveAdminActionJob({
      jobId: id,
      approvedBy: "admin_ui",
    });
    if (r.ok) ok += 1;
    else {
      failed += 1;
      if (r.errorMessage) errors.push(`${id}: ${r.errorMessage}`);
    }
  }
  revalidateAdminPaths();
  return { ok, failed, errors };
}

export async function refreshNeighborPerformanceAction(
  performanceId: string,
): Promise<{ ok: boolean; status?: string; errorMessage?: string }> {
  const result = await refreshNeighborPerformanceFromMeta({ performanceId });
  revalidateAdminPaths();
  return result;
}
