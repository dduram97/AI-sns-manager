/**
 * /api/cron/relation-sync — daily blog relation analysis (KST 00:00).
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 * Manual: Bearer <AGENT_TICK_SECRET> or x-agent-tick-secret + { force?: true }
 */

import { NextResponse } from "next/server";
import { authorizeAgentTickRequest } from "@/services/agentTickService";
import { runRelationSyncBatch } from "@/services/relationSyncService";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: Request) {
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

  let force = false;
  if (request.method === "POST") {
    try {
      const body = (await request.json().catch(() => null)) as {
        force?: boolean;
      } | null;
      force = body?.force === true;
    } catch {
      force = false;
    }
  }

  const source = auth.source === "manual" ? "manual" : "cron";
  const result = await runRelationSyncBatch({ source, force });
  const status =
    result.status === "failed" ? 500 : result.status === "skipped" ? 200 : 200;
  return NextResponse.json(result, { status });
}

/** Vercel Cron GET */
export async function GET(request: Request) {
  return handle(request);
}

/** Manual POST (optional force) */
export async function POST(request: Request) {
  return handle(request);
}
