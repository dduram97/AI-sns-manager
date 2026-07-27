/**
 * Inter-job delay for Approval Inbox batch execution queue.
 * Sequential only — not Policy / Decision / Adapter architecture.
 */

const DEFAULT_MIN_MS = 5_000;
const DEFAULT_MAX_MS = 10_000;

export function batchQueueDelayRangeMs(): { minMs: number; maxMs: number } {
  const minRaw = process.env.APPROVAL_BATCH_DELAY_MIN_MS;
  const maxRaw = process.env.APPROVAL_BATCH_DELAY_MAX_MS;
  const minMs =
    minRaw && Number.isFinite(Number(minRaw)) ? Number(minRaw) : DEFAULT_MIN_MS;
  const maxMs =
    maxRaw && Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : DEFAULT_MAX_MS;
  return { minMs: Math.max(0, minMs), maxMs: Math.max(minMs, maxMs) };
}

export function randomBatchQueueDelayMs(): number {
  const { minMs, maxMs } = batchQueueDelayRangeMs();
  if (maxMs <= minMs) return minMs;
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

export type BatchQueueDelayOptions = {
  /** Fixed delay in ms (UI interval). When set, skips random env range. */
  fixedMs?: number;
  /** Override random range min (ms). */
  minMs?: number;
  /** Override random range max (ms). */
  maxMs?: number;
};

export function resolveBatchQueueDelayMs(
  opts?: BatchQueueDelayOptions,
): number {
  if (opts?.fixedMs != null && Number.isFinite(opts.fixedMs)) {
    return Math.max(0, Math.floor(opts.fixedMs));
  }
  const env = batchQueueDelayRangeMs();
  const minMs =
    opts?.minMs != null && Number.isFinite(opts.minMs)
      ? Math.max(0, opts.minMs)
      : env.minMs;
  const maxMs =
    opts?.maxMs != null && Number.isFinite(opts.maxMs)
      ? Math.max(minMs, opts.maxMs)
      : Math.max(minMs, env.maxMs);
  if (maxMs <= minMs) return minMs;
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

export async function applyBatchQueueDelay(
  opts?: BatchQueueDelayOptions,
): Promise<number> {
  const ms = resolveBatchQueueDelayMs(opts);
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  return ms;
}

/** Convert UI interval (seconds or minutes) to milliseconds. */
export function intervalToMs(
  value: number,
  unit: "sec" | "min",
): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const n = Math.floor(value);
  return unit === "min" ? n * 60_000 : n * 1_000;
}
