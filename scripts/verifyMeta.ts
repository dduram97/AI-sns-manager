/**
 * Verify-only markers — never set on operational Persons.
 * Stored in persons.discover_meta (no schema / Spec change).
 */

export const VERIFY_META = {
  flag: "verify" as const,
  runId: "test_run_id" as const,
  caseId: "verify_case" as const,
};

export function newTestRunId(): string {
  return `vfy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildVerifyDiscoverMeta(
  testRunId: string,
  caseId: string,
  rest: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...rest,
    [VERIFY_META.flag]: true,
    [VERIFY_META.runId]: testRunId,
    [VERIFY_META.caseId]: caseId,
  };
}

export function isVerifyPersonMeta(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return meta?.[VERIFY_META.flag] === true;
}

export function testRunIdFromMeta(
  meta: Record<string, unknown> | null | undefined,
): string | null {
  const v = meta?.[VERIFY_META.runId];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
