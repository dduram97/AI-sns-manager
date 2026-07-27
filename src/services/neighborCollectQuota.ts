/**
 * Neighbor collect volume targets.
 * Example: save 30 → search ~200 → code-score all passers → AI top 50 → save 30
 */

export function neighborCollectTargets(
  dailyQuota: number,
  aiAnalyzeMax = 50,
): {
  searchMax: number;
  /** Soft pool size hint (not a hard AI cap) */
  filterMax: number;
  aiMax: number;
  saveMax: number;
} {
  const saveMax = Math.max(1, Math.min(100, Math.floor(dailyQuota)));
  const searchMax = Math.min(200, Math.max(100, saveMax * 7));
  const aiMax = Math.min(100, Math.max(5, Math.floor(aiAnalyzeMax)));
  return {
    searchMax,
    filterMax: aiMax,
    aiMax,
    saveMax,
  };
}
