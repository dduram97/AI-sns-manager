/**
 * Dev/verify helper: insert a planned comment action_job for CDP Worker tests.
 *
 * Usage:
 *   npm run test:create-comment -- --url=https://m.blog.naver.com/{blogId}/{logNo}
 *   npm run test:create-comment -- --url=... --body=테스트 댓글입니다
 *   WORKER_TEST_COMMENT_URL=https://... npm run test:create-comment
 *   WORKER_TEST_POST_URL=https://... npm run test:create-comment
 *
 * Optional:
 *   WORKER_TEST_PERSON_ID / WORKER_TEST_WORKFLOW_ID — reuse existing FKs
 *   WORKER_TEST_COMMENT_BODY / --body — comment text (default short smoke draft)
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServiceClient } from "../src/lib/supabase";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, "worker", ".env"), override: true });

const DEFAULT_COMMENT_BODY = "cdp worker comment smoke test";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim() || null;
    if (a === `--${name}`) {
      const idx = process.argv.indexOf(a);
      const next = process.argv[idx + 1];
      if (next && !next.startsWith("--")) return next.trim();
    }
  }
  return null;
}

function resolveTargetUrl(): string {
  const fromArg =
    argValue("url") ?? argValue("target_url") ?? argValue("target-url");
  const fromEnv =
    process.env.WORKER_TEST_COMMENT_URL?.trim() ||
    process.env.WORKER_TEST_POST_URL?.trim() ||
    process.env.TARGET_URL?.trim() ||
    "";
  const url = (fromArg || fromEnv).trim();
  if (!url) {
    throw new Error(
      "target_url required. Example:\n" +
        "  npm run test:create-comment -- --url=https://m.blog.naver.com/blogId/123\n" +
        "  WORKER_TEST_COMMENT_URL=https://... npm run test:create-comment",
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`invalid target_url: ${url}`);
  }
  if (!/blog\.naver\.com\/[^/?#]+\/\d+/i.test(url) && !/[?&]logNo=\d+/i.test(url)) {
    throw new Error(
      `comment job needs a post URL (blogId/logNo), got: ${url}`,
    );
  }
  return url;
}

function resolveCommentBody(): string {
  const fromArg =
    argValue("body") ??
    argValue("draft") ??
    argValue("comment") ??
    argValue("comment_text") ??
    argValue("comment-text");
  const fromEnv =
    process.env.WORKER_TEST_COMMENT_BODY?.trim() ||
    process.env.WORKER_TEST_DRAFT_BODY?.trim() ||
    "";
  const body = (fromArg || fromEnv || DEFAULT_COMMENT_BODY).trim();
  if (!body) {
    throw new Error("comment body is empty");
  }
  return body;
}

function buildTargetRef(
  url: string,
  commentBody: string,
): Record<string, unknown> {
  const ref: Record<string, unknown> = {
    post_url: url,
    url,
    worker_test: true,
    smoke: "cdp_worker_comment",
    comment_text: commentBody,
    draft: commentBody,
  };

  const m =
    url.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/i) ||
    url.match(/[?&]blogId=([^&]+).*?[?&]logNo=(\d+)/i);
  if (m) {
    ref.blog_id = decodeURIComponent(m[1]!);
    ref.log_no = m[2];
  } else {
    const blogOnly = url.match(/blog\.naver\.com\/([^/?#]+)/i);
    if (blogOnly) ref.blog_id = decodeURIComponent(blogOnly[1]!);
  }

  return ref;
}

async function resolvePersonAndWorkflow(
  db: ReturnType<typeof createServiceClient>,
): Promise<{ personId: string; workflowId: string; created: boolean }> {
  const envPerson = process.env.WORKER_TEST_PERSON_ID?.trim();
  const envWorkflow = process.env.WORKER_TEST_WORKFLOW_ID?.trim();

  if (envPerson && envWorkflow) {
    return { personId: envPerson, workflowId: envWorkflow, created: false };
  }

  if (envPerson) {
    const { data: existingWf, error: wfErr } = await db
      .from("workflows")
      .select("id")
      .eq("person_id", envPerson)
      .in("current_state", ["active", "waiting", "blocked"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (wfErr) throw new Error(`lookup workflow: ${wfErr.message}`);
    if (existingWf?.id) {
      return {
        personId: envPerson,
        workflowId: String(existingWf.id),
        created: false,
      };
    }

    const { data: wf, error: createWfErr } = await db
      .from("workflows")
      .insert({
        person_id: envPerson,
        current_stage: "warming",
        current_state: "active",
        next_action: "comment",
        priority: 5,
        goal: "cdp_worker_test_comment",
      })
      .select("id")
      .single();
    if (createWfErr) throw new Error(`create workflow: ${createWfErr.message}`);
    await db
      .from("persons")
      .update({ active_workflow_id: wf.id })
      .eq("id", envPerson);
    return {
      personId: envPerson,
      workflowId: String(wf.id),
      created: true,
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { data: person, error: personErr } = await db
    .from("persons")
    .insert({
      display_name: `[cdp-worker:test-comment] ${stamp}`,
      discover_meta: {
        worker_test: true,
        purpose: "cdp_worker_comment",
        created_at: new Date().toISOString(),
      },
    })
    .select("id")
    .single();
  if (personErr) throw new Error(`create person: ${personErr.message}`);

  await db.from("relationship_states").upsert({
    person_id: person.id,
    stage: "warming",
    score: 0,
    temperature: 0,
  });

  const { data: wf, error: wfErr } = await db
    .from("workflows")
    .insert({
      person_id: person.id,
      current_stage: "warming",
      current_state: "active",
      next_action: "comment",
      priority: 5,
      goal: "cdp_worker_test_comment",
    })
    .select("id")
    .single();
  if (wfErr) throw new Error(`create workflow: ${wfErr.message}`);

  await db
    .from("persons")
    .update({ active_workflow_id: wf.id })
    .eq("id", person.id);

  return {
    personId: String(person.id),
    workflowId: String(wf.id),
    created: true,
  };
}

async function main() {
  const targetUrl = resolveTargetUrl();
  const commentBody = resolveCommentBody();
  const targetRef = buildTargetRef(targetUrl, commentBody);
  const db = createServiceClient();

  const { personId, workflowId, created } = await resolvePersonAndWorkflow(db);

  const { data: job, error } = await db
    .from("action_jobs")
    .insert({
      parent_workflow_id: workflowId,
      person_id: personId,
      channel: "blog",
      action_type: "comment",
      // action_jobs_risk_matrix: comment/neighbor_request/threads_reply => high
      risk: "high",
      status: "planned",
      draft_body: commentBody,
      target_ref: targetRef,
      inbox_priority: 0,
    })
    .select("id, action_type, status, draft_body, target_ref, created_at")
    .single();

  if (error) {
    throw new Error(`create action_job: ${error.message}`);
  }

  console.info("[test:create-comment] created", {
    jobId: job.id,
    action_type: job.action_type,
    status: job.status,
    draft_body: job.draft_body,
    personId,
    workflowId,
    fixturesCreated: created,
    target_ref: job.target_ref,
  });
  console.info(job.id);
}

main().catch((err) => {
  console.error(
    "[test:create-comment] failed",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
