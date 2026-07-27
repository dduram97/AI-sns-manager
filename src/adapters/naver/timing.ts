/**
 * Adapter-local random execution delays (not Policy / Decision).
 * Keeps light human-like spacing inside NaverBlogAdapter only.
 * Tuned for approval UX speed while keeping Naver UI settle room.
 */

export type NaverDelayKind = "visit" | "like" | "comment" | "mutual_request" | "sync";

const DEFAULT_RANGES: Record<NaverDelayKind, { minMs: number; maxMs: number }> = {
  visit: { minMs: 400, maxMs: 1_200 },
  like: { minMs: 500, maxMs: 1_400 },
  comment: { minMs: 600, maxMs: 1_800 },
  mutual_request: { minMs: 2_000, maxMs: 5_000 },
  sync: { minMs: 200, maxMs: 600 },
};

function envRange(kind: NaverDelayKind): { minMs: number; maxMs: number } {
  const base = DEFAULT_RANGES[kind];
  const minRaw = process.env[`NAVER_DELAY_${kind.toUpperCase()}_MIN_MS`];
  const maxRaw = process.env[`NAVER_DELAY_${kind.toUpperCase()}_MAX_MS`];
  const minMs = minRaw && Number.isFinite(Number(minRaw)) ? Number(minRaw) : base.minMs;
  const maxMs = maxRaw && Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : base.maxMs;
  return { minMs: Math.max(0, minMs), maxMs: Math.max(minMs, maxMs) };
}

export function randomDelayMs(kind: NaverDelayKind): number {
  const { minMs, maxMs } = envRange(kind);
  if (maxMs <= minMs) return minMs;
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

export async function applyAdapterDelay(kind: NaverDelayKind): Promise<number> {
  const ms = randomDelayMs(kind);
  await new Promise((r) => setTimeout(r, ms));
  return ms;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until predicate is true or deadline. Prefer over fixed long sleeps. */
export async function waitUntil(
  predicate: () => Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 4_000;
  const intervalMs = opts?.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}
