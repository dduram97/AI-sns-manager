export type TodaySummaryViewModel = {
  neighborFeed: {
    pending: number;
    completed: number;
  };
  neighborRequest: {
    candidates: number;
    /** Successful executed only */
    completed: number;
    failed: number;
    excluded: number;
    dailyLimit: number;
    remaining: number;
  };
  comment: {
    pending: number;
    completed: number;
  };
};
