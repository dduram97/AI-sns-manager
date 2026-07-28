/** Unified [action_result] log for admin adapter + worker parity. */
export function logActionResult(input: {
  jobId: string;
  actionType: string;
  status: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  executionResult?: Record<string, unknown> | null;
}): void {
  console.info("[action_result]", {
    jobId: input.jobId,
    actionType: input.actionType,
    status: input.status,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    executionResult: input.executionResult ?? null,
  });
}
