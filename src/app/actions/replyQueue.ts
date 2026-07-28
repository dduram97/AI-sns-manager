"use server";

import { revalidatePath } from "next/cache";
import { enqueueReplyVisit } from "@/services/replyVisitService";

export async function enqueueReplyVisitAction(input: {
  relationId?: string;
  personId?: string;
  blogId?: string;
  mode?: "like" | "comment";
}): Promise<
  | {
      ok: true;
      approvalId: string;
      actionJobId: string;
      actionType: "like" | "comment";
      risk: "low" | "high";
      postUrl: string;
    }
  | { ok: false; error: string }
> {
  const result = await enqueueReplyVisit(input);
  if (result.ok) {
    console.info("[reply_visit][action]", {
      actionType: result.actionType,
      approvalId: result.approvalId,
      actionJobId: result.actionJobId,
      risk: result.risk,
    });
    revalidatePath("/today/approvals");
    revalidatePath("/neighbors/reply");
  } else {
    console.warn("[reply_visit][action] failed", { error: result.error, mode: input.mode });
  }
  return result;
}
