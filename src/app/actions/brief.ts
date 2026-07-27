"use server";

import { getAgentBrief, type AgentBriefViewModel } from "@/services/getAgentBrief";

export async function getAgentBriefAction(): Promise<AgentBriefViewModel> {
  console.log("[today] action refetch start");
  const vm = await getAgentBrief();
  console.log(
    `[today] action refetch done approvalCount=${vm.approvalCount} intervention=${vm.interventionMinutes}`,
  );
  return vm;
}
