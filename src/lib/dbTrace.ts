import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

export type DbTraceEntry = {
  name: string;
  durationMs: number;
  rowCount: number | null;
};

type DbTraceStore = {
  scope: string;
  queries: DbTraceEntry[];
};

const dbTraceStorage = new AsyncLocalStorage<DbTraceStore>();

function rowCountFrom(data: unknown, count?: number | null): number | null {
  if (typeof count === "number") return count;
  if (Array.isArray(data)) return data.length;
  if (data != null) return 1;
  return 0;
}

export async function traceQuery<T>(
  name: string,
  run: () => PromiseLike<T>,
  countFrom?: (result: T) => number | null,
): Promise<T> {
  const store = dbTraceStorage.getStore();
  const start = performance.now();
  const result = await run();
  const durationMs = Math.round(performance.now() - start);
  if (store) {
    store.queries.push({
      name,
      durationMs,
      rowCount: countFrom ? countFrom(result) : null,
    });
  }
  return result;
}

export function runWithDbTrace<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const store: DbTraceStore = { scope, queries: [] };
  return dbTraceStorage.run(store, async () => {
    try {
      return await fn();
    } finally {
      flushDbTrace(store);
    }
  });
}

function flushDbTrace(store: DbTraceStore) {
  const total = store.queries.reduce((sum, q) => sum + q.durationMs, 0);
  console.log(`[${store.scope}] queries: ${store.queries.length} total: ${total}ms`);
  for (const q of store.queries) {
    console.log(
      `[${store.scope}] query=${q.name} duration=${q.durationMs}ms rows=${q.rowCount ?? "-"}`,
    );
  }
  const slow = store.queries
    .filter((q) => q.durationMs >= 100)
    .sort((a, b) => b.durationMs - a.durationMs);
  if (slow.length > 0) {
    console.log(`[${store.scope}] slow queries:`);
    for (const q of slow) {
      console.log(`[${store.scope}] slow query=${q.name} duration=${q.durationMs}ms`);
    }
  }
}

/** Wrap a Supabase response for automatic row counting. */
export function tracedRows<T extends { data: unknown; count?: number | null }>(
  result: T,
): T {
  return result;
}

export { rowCountFrom, dbTraceStorage };
