import { TodayRecommendedNeighborCard } from "@/components/brief/TodayRecommendedNeighborCard";
import { TodayTopNeighborCard } from "@/components/brief/TodayTopNeighborCard";
import { TodayWeeklyStatsCard } from "@/components/brief/TodayWeeklyStatsCard";
import { getRecommendedNeighbors } from "@/services/todayDashboard/getRecommendedNeighbors";
import { getTopNeighbors } from "@/services/todayDashboard/getTopNeighbors";
import { getTodayWeeklyStats } from "@/services/getTodayDashboard";

export async function TodayDashboardSection() {
  const [weekly, topNeighbors, recommendedNeighbors] = await Promise.all([
    getTodayWeeklyStats(),
    getTopNeighbors(),
    getRecommendedNeighbors(),
  ]);

  return (
    <section className="flex flex-col gap-4">
      <div className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight">📈 이번 주</h2>
        <TodayWeeklyStatsCard stats={weekly} />
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight">🏆 교류 TOP</h2>
        <div className="flex flex-col gap-3">
          {topNeighbors.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
              최근 30일 교류 기록이 없습니다.
            </p>
          ) : (
            topNeighbors.map((neighbor) => (
              <TodayTopNeighborCard key={neighbor.id} neighbor={neighbor} />
            ))
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight">💡 추천 이웃</h2>
        <div className="flex flex-col gap-3">
          {recommendedNeighbors.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
              현재 추천할 이웃이 없습니다.
            </p>
          ) : (
            recommendedNeighbors.map((neighbor) => (
              <TodayRecommendedNeighborCard
                key={neighbor.id}
                neighbor={neighbor}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}
