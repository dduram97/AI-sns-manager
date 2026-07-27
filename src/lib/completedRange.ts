/**
 * Date range helpers for Approval "처리완료" tab filters (KST calendar days).
 */

export type CompletedRangePreset = "today" | "7d" | "30d" | "custom";

export type CompletedRangeQuery = {
  preset: CompletedRangePreset;
  /** YYYY-MM-DD — used when preset=custom */
  fromDate?: string;
  /** YYYY-MM-DD — used when preset=custom */
  toDate?: string;
};

export type ResolvedIsoRange = {
  fromIso: string;
  toIso: string;
  label: string;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstParts(d = new Date()): {
  y: number;
  m: number;
  day: number;
} {
  const kst = new Date(d.getTime() + KST_OFFSET_MS);
  return {
    y: kst.getUTCFullYear(),
    m: kst.getUTCMonth(),
    day: kst.getUTCDate(),
  };
}

/** KST calendar date as YYYY-MM-DD */
export function kstTodayYmd(d = new Date()): string {
  const { y, m, day } = kstParts(d);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Start of KST calendar day → UTC ISO */
function startOfKstDay(y: number, m: number, day: number): string {
  return new Date(Date.UTC(y, m, day) - KST_OFFSET_MS).toISOString();
}

/** End of KST calendar day (inclusive) → UTC ISO */
function endOfKstDay(y: number, m: number, day: number): string {
  return new Date(
    Date.UTC(y, m, day, 23, 59, 59, 999) - KST_OFFSET_MS,
  ).toISOString();
}

function parseYmd(ymd: string): { y: number; m: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (!Number.isFinite(y) || mo < 0 || mo > 11 || day < 1 || day > 31) {
    return null;
  }
  return { y, m: mo, day };
}

export function resolveCompletedRange(
  query?: CompletedRangeQuery | null,
): ResolvedIsoRange {
  const preset = query?.preset ?? "7d";
  const now = kstParts();

  if (preset === "today") {
    return {
      fromIso: startOfKstDay(now.y, now.m, now.day),
      toIso: endOfKstDay(now.y, now.m, now.day),
      label: "오늘",
    };
  }

  if (preset === "30d") {
    const from = new Date(Date.UTC(now.y, now.m, now.day) - 29 * 86_400_000);
    return {
      fromIso: startOfKstDay(
        from.getUTCFullYear(),
        from.getUTCMonth(),
        from.getUTCDate(),
      ),
      toIso: endOfKstDay(now.y, now.m, now.day),
      label: "최근 30일",
    };
  }

  if (preset === "custom") {
    const fromParts = parseYmd(query?.fromDate ?? "") ?? now;
    const toParts = parseYmd(query?.toDate ?? "") ?? now;
    let fromIso = startOfKstDay(fromParts.y, fromParts.m, fromParts.day);
    let toIso = endOfKstDay(toParts.y, toParts.m, toParts.day);
    if (fromIso > toIso) {
      const tmp = fromIso;
      fromIso = startOfKstDay(toParts.y, toParts.m, toParts.day);
      toIso = endOfKstDay(fromParts.y, fromParts.m, fromParts.day);
    }
    return {
      fromIso,
      toIso,
      label: "직접 선택",
    };
  }

  // default 7d (today inclusive → 7 calendar days)
  const from = new Date(Date.UTC(now.y, now.m, now.day) - 6 * 86_400_000);
  return {
    fromIso: startOfKstDay(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
    ),
    toIso: endOfKstDay(now.y, now.m, now.day),
    label: "최근 7일",
  };
}

function formatKstYmd(y: number, m: number, day: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** KST calendar week (Mon 00:00 → today end, inclusive). */
export function resolveWeekRange(): ResolvedIsoRange & {
  fromDate: string;
  toDate: string;
} {
  const now = kstParts();
  const kst = new Date(Date.now() + KST_OFFSET_MS);
  const dow = kst.getUTCDay();
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(
    Date.UTC(now.y, now.m, now.day) - daysFromMonday * 86_400_000,
  );
  const fromY = monday.getUTCFullYear();
  const fromM = monday.getUTCMonth();
  const fromD = monday.getUTCDate();

  return {
    fromIso: startOfKstDay(fromY, fromM, fromD),
    toIso: endOfKstDay(now.y, now.m, now.day),
    fromDate: formatKstYmd(fromY, fromM, fromD),
    toDate: formatKstYmd(now.y, now.m, now.day),
    label: "이번 주",
  };
}

export function completedRangePresetLabel(
  preset: CompletedRangePreset,
): string {
  switch (preset) {
    case "today":
      return "오늘";
    case "7d":
      return "최근 7일";
    case "30d":
      return "최근 30일";
    case "custom":
      return "직접 선택";
  }
}
