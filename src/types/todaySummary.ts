export type TodaySummaryViewModel = {
  neighborFeed: {
    pending: number;
    completed: number;
  };
  neighborRequest: {
    candidates: number;
    completed: number;
  };
  comment: {
    pending: number;
    completed: number;
  };
};
