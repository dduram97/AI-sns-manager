import { ApprovalInboxScreen } from "@/components/approval/ApprovalInboxScreen";
import {
  listApprovalInbox,
  listCompletedApprovals,
} from "@/services/approvalService";

export const dynamic = "force-dynamic";
/** Batch comment queue may wait random delays between jobs. */
export const maxDuration = 300;

export default async function ApprovalsPage() {
  const [items, initialCompleted] = await Promise.all([
    listApprovalInbox(),
    listCompletedApprovals({ page: 1, pageSize: 20, preset: "7d" }),
  ]);
  return (
    <ApprovalInboxScreen items={items} initialCompleted={initialCompleted} />
  );
}
