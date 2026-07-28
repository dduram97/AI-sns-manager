import { ReplyVisitManageScreen } from "@/components/neighbor/ReplyVisitManageScreen";

export const dynamic = "force-dynamic";
/** Browser CDP like/comment can exceed default serverless limits. */
export const maxDuration = 300;

export default function NeighborsReplyPage() {
  return <ReplyVisitManageScreen />;
}
