export type TodayWeeklyStats = {
  visitors: number;
  likes: number;
  comments: number;
  newNeighbors: number;
};

export type TodayTopNeighbor = {
  id: string;
  blogName: string;
  stars: number;
  lastVisit: string;
  lastComment: string;
  lastLike: string;
  recentPostTitle: string;
  recentPostAt: string;
  interactionScore: number;
  blogUrl: string;
  isAccepted: boolean;
};

export type TodayRecommendedNeighbor = {
  id: string;
  blogName: string;
  stars: number;
  reasons: string[];
  recentPostTitle: string;
  recentPostAt: string;
  lastVisit: string;
  lastComment: string;
  recommendScore: number;
  blogId: string;
  blogUrl: string;
};

export type TodayDashboardViewModel = {
  weekly: TodayWeeklyStats;
  topNeighbors: TodayTopNeighbor[];
  recommendedNeighbors: TodayRecommendedNeighbor[];
};
