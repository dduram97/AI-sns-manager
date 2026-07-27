/**
 * Persist Naver browser session health for Live ops (relogin signal).
 * File-based — no schema / Decision change.
 */

import fs from "node:fs";
import path from "node:path";

export type SessionHealthState =
  | "unknown"
  | "logged_in"
  | "logged_out"
  | "needs_relogin"
  | "expired"
  | "error";

export interface SessionHealthSnapshot {
  state: SessionHealthState;
  reason: string | null;
  checked_at: string;
  adapter_mode: string;
}

function healthPath(): string {
  const profile =
    process.env.NAVER_BROWSER_PROFILE ??
    process.env.BROWSER_USER_DATA_DIR ??
    path.join(process.cwd(), ".data", "browser", "naver-profile");
  return path.join(path.dirname(profile), "naver-session-health.json");
}

export function readSessionHealth(): SessionHealthSnapshot | null {
  const p = healthPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as SessionHealthSnapshot;
    return raw;
  } catch {
    return null;
  }
}

export function writeSessionHealth(
  state: SessionHealthState,
  reason?: string | null,
): SessionHealthSnapshot {
  const snap: SessionHealthSnapshot = {
    state,
    reason: reason ?? null,
    checked_at: new Date().toISOString(),
    adapter_mode: (process.env.NAVER_ADAPTER_MODE ?? "live").toLowerCase(),
  };
  const p = healthPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(snap, null, 2), "utf8");
  return snap;
}

export function clearSessionHealth(): void {
  const p = healthPath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

/**
 * Hard-block only for a short TTL after a real failure.
 * Stale needs_relogin must not permanently prevent verify/retry
 * (previous run's locator.click error was stuck forever).
 */
export function isReloginRequired(
  health?: SessionHealthSnapshot | null,
): boolean {
  const h = health ?? readSessionHealth();
  if (!h) return false;
  // logged_out alone is recoverable via ensureNaverLogin + credentials
  if (
    h.state !== "needs_relogin" &&
    h.state !== "expired" &&
    h.state !== "error"
  ) {
    return false;
  }
  const ttlMs = Number(process.env.NAVER_RELOGIN_BLOCK_TTL_MS ?? "0");
  const checked = Date.parse(h.checked_at);
  if (!Number.isFinite(checked)) return false;
  const age = Date.now() - checked;
  // Default TTL=0: never hard-block (stale needs_relogin previously blocked verify forever).
  // Set NAVER_RELOGIN_BLOCK_TTL_MS=30000 to briefly pause after a failure.
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  return age >= 0 && age < ttlMs;
}
