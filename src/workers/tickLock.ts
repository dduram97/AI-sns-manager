/**
 * Agent Tick distributed lock via brief_snapshots.status_detail (no schema change).
 * Optimistic concurrency on updated_at prevents concurrent acquires.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../lib/supabase";

const LOCK_TTL_MS = () =>
  Number(process.env.AGENT_TICK_LOCK_TTL_MS ?? 600_000) || 600_000;

/** Process-local guard (same Node instance). */
let localHeld = false;

export type TickLockAcquireResult =
  | { ok: true; token: string }
  | { ok: false; reason: "local" | "busy"; lockUntil?: string };

export async function acquireTickLock(
  db: DatabaseClient,
): Promise<TickLockAcquireResult> {
  if (localHeld) {
    return { ok: false, reason: "local" };
  }

  const { data: row, error } = await db
    .from("brief_snapshots")
    .select("status_detail, updated_at")
    .eq("id", true)
    .single();
  if (error || !row) {
    throw new Error(`acquireTickLock: ${error?.message ?? "brief missing"}`);
  }

  const now = Date.now();
  const detail = (row.status_detail ?? {}) as Record<string, unknown>;
  const untilRaw =
    typeof detail.tick_lock_until === "string" ? detail.tick_lock_until : null;
  const untilMs = untilRaw ? Date.parse(untilRaw) : 0;
  if (untilMs > now) {
    return { ok: false, reason: "busy", lockUntil: untilRaw ?? undefined };
  }

  const token = randomUUID();
  const lockUntil = new Date(now + LOCK_TTL_MS()).toISOString();
  const nextDetail = {
    ...detail,
    tick_lock_token: token,
    tick_lock_until: lockUntil,
    tick_lock_at: new Date(now).toISOString(),
  };

  const { data: updated, error: updErr } = await db
    .from("brief_snapshots")
    .update({ status_detail: nextDetail })
    .eq("id", true)
    .eq("updated_at", row.updated_at)
    .select("status_detail")
    .maybeSingle();

  if (updErr) {
    throw new Error(`acquireTickLock update: ${updErr.message}`);
  }
  const got = (updated?.status_detail ?? {}) as Record<string, unknown>;
  if (!updated || got.tick_lock_token !== token) {
    return { ok: false, reason: "busy", lockUntil: untilRaw ?? undefined };
  }

  localHeld = true;
  return { ok: true, token };
}

export async function releaseTickLock(
  db: DatabaseClient,
  token: string,
): Promise<void> {
  try {
    const { data: row } = await db
      .from("brief_snapshots")
      .select("status_detail, updated_at")
      .eq("id", true)
      .single();
    if (!row) return;

    const detail = {
      ...((row.status_detail ?? {}) as Record<string, unknown>),
    };
    if (detail.tick_lock_token !== token) {
      return;
    }
    delete detail.tick_lock_token;
    delete detail.tick_lock_until;
    delete detail.tick_lock_at;

    await db
      .from("brief_snapshots")
      .update({ status_detail: detail })
      .eq("id", true)
      .eq("updated_at", row.updated_at);
  } finally {
    localHeld = false;
  }
}

export async function withTickLock<T>(
  db: DatabaseClient,
  fn: () => Promise<T>,
): Promise<
  | { acquired: true; value: T }
  | { acquired: false; reason: "local" | "busy"; lockUntil?: string }
> {
  const lock = await acquireTickLock(db);
  if (!lock.ok) {
    return {
      acquired: false,
      reason: lock.reason,
      lockUntil: lock.lockUntil,
    };
  }
  try {
    const value = await fn();
    return { acquired: true, value };
  } finally {
    await releaseTickLock(db, lock.token);
  }
}
