import { unstable_noStore as noStore } from "next/cache";
import { AgentBriefPanel } from "@/components/brief/AgentBriefPanel";
import { AgentBriefShell } from "@/components/brief/AgentBriefShell";
import { TodayDashboardSection } from "@/components/brief/TodayDashboardSection";
import { TodayReplyVisitSummarySection } from "@/components/brief/TodayReplyVisitSummarySection";
import { TodaySummarySection } from "@/components/brief/TodaySummarySection";

export const dynamic = "force-dynamic";

export default function TodayPage() {
  noStore();
  console.log("[today] page shell render");
  return (
    <AgentBriefShell>
      <TodayReplyVisitSummarySection />
      <TodaySummarySection />
      <TodayDashboardSection />
      <AgentBriefPanel />
    </AgentBriefShell>
  );
}
