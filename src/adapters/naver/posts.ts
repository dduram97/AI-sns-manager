export interface NaverPostSnapshot {
  blogId: string;
  logNo: string;
  postUrl: string;
  title: string;
  /** Raw body text used to build summary */
  contentRaw: string;
  contentSummary: string;
  publishedAt: string | null;
}

export function summarizeContent(raw: string, max = 280): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max).trim()}…`;
}
