/**
 * /api/agent/tick — Vercel Cron (GET) + manual (POST).
 * ARCHITECTURE_SPEC §10 / §12.
 *
 * Auth:
 * - Vercel Cron: Authorization: Bearer <CRON_SECRET>
 * - Manual: Bearer <AGENT_TICK_SECRET> or x-agent-tick-secret
 *
 * Duplicate runs blocked via withTickLock.
 */

import { NextResponse } from "next/server";
import {
  authorizeAgentTickRequest,
  runAgentTickLocked,
  type TickRequestSource,
} from "@/services/agentTickService";
import { createServiceClient } from "@/lib/supabase";
import { persistTickRunLog } from "@/workers/tickRunLog";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function detectSource(
  request: Request,
  authSource: TickRequestSource,
): TickRequestSource {
  if (authSource === "cron") return "cron";
  const ua = request.headers.get("user-agent") ?? "";
  if (ua.includes("vercel-cron")) return "cron";
  return authSource === "manual" ? "manual" : "unknown";
}

async function handleTick(request: Request) {
  const auth = authorizeAgentTickRequest(
    request.headers.get("authorization"),
    request.headers.get("x-agent-tick-secret"),
  );
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const source = detectSource(request, auth.source);
  let includeLogs = false;
  if (request.method === "POST") {
    try {
      const body = (await request.json().catch(() => null)) as {
        includeLogs?: boolean;
      } | null;
      includeLogs = body?.includeLogs === true;
    } catch {
      includeLogs = false;
    }
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await runAgentTickLocked({ includeLogs, source });
    if (!result.ok) {
      return NextResponse.json(result, { status: 409 });
    }
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[api/agent/tick]", err);
    const finishedAt = new Date().toISOString();
    try {
      await persistTickRunLog(createServiceClient(), {
        started_at: startedAt,
        finished_at: finishedAt,
        perceptions_processed: 0,
        approvals_created: 0,
        actions_executed: 0,
        actions_failed: 0,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        source,
      });
    } catch {
      // ignore secondary log failure
    }
    return NextResponse.json(
      {
        ok: false,
        error: "tick_failed",
        startedAt,
        finishedAt,
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/** Vercel Cron invokes GET with Bearer CRON_SECRET. */
export async function GET(request: Request) {
  return handleTick(request);
}

/** Manual / external schedulers may POST. */
export async function POST(request: Request) {
  return handleTick(request);
}
