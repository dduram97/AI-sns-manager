/**
 * Dev/verify helper: insert a planned neighbor_request action_job for CDP Worker tests.
 *
 * Usage:
 *   npm run test:create-neighbor -- --blogId=someBlogId
 *   npm run test:create-neighbor -- --url=https://m.blog.naver.com/{blogId}
 *   WORKER_TEST_NEIGHBOR_BLOG_ID=... npm run test:create-neighbor
 *   WORKER_TEST_POST_URL=https://... npm run test:create-neighbor
 *
 * Optional:
 *   WORKER_TEST_PERSON_ID / WORKER_TEST_WORKFLOW_ID — reuse existing FKs
 *   --body / WORKER_TEST_NEIGHBOR_BODY — draft message (optional)
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServiceClient } from "../src/lib/supabase";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, "worker", ".env"), override: true });

const DEFAULT_MESSAGE =
  "안녕하세요. 관심사가 비슷해 서로이웃 신청드립니다. (cdp worker smoke)";

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

function toMBlogUrl(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\/blog\.naver\.com\//i, "https://m.blog.naver.com/")
    .replace(
      /^https?:\/\/m\.blog\.naver\.com\//i,
      "https://m.blog.naver.com/",
    );
}

function extractBlogIdFromUrl(url: string): string | null {
  const normalized = toMBlogUrl(url);
  const m =
    normalized.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/i) ||
    normalized.match(/blog\.naver\.com\/([^/?#]+)/i) ||
    normalized.match(/[?&]blogId=([^&]+)/i);
  if (!m?.[1]) return null;
  const id = decodeURIComponent(m[1]!);
  if (/^(PostView|PostList|BuddyAdd|buddyadd|section)$/i.test(id)) return null;
  return id;
}

function resolveBlogIdAndUrl(): { blogId: string; blogUrl: string } {
  const fromBlogArg =
    argValue("blogId") ??
    argValue("blog_id") ??
    argValue("blog-id") ??
    argValue("blogid");
  const fromUrlArg =
    argValue("url") ?? argValue("target_url") ?? argValue("target-url");
  const fromEnvBlog =
    process.env.WORKER_TEST_NEIGHBOR_BLOG_ID?.trim() ||
    process.env.WORKER_TEST_BLOG_ID?.trim() ||
    "";
  const fromEnvUrl =
    process.env.WORKER_TEST_NEIGHBOR_URL?.trim() ||
    process.env.WORKER_TEST_POST_URL?.trim() ||
    process.env.TARGET_URL?.trim() ||
    "";

  let blogId = (fromBlogArg || fromEnvBlog || "").trim();
  let blogUrl = "";

  if (fromUrlArg || fromEnvUrl) {
    const raw = (fromUrlArg || fromEnvUrl).trim();
    try {
      // eslint-disable-next-line no-new
      new URL(raw);
    } catch {
      throw new Error(`invalid url: ${raw}`);
    }
    const extracted = extractBlogIdFromUrl(raw);
    if (!extracted) {
      throw new Error(`could not extract blogId from url: ${raw}`);
    }
    if (blogId && blogId !== extracted) {
      throw new Error(
        `blogId mismatch: --blogId=${blogId} vs url blogId=${extracted}`,
      );
    }
    blogId = blogId || extracted;
    // Prefer blog home URL (strip logNo path when present).
    blogUrl = `https://m.blog.naver.com/${blogId}`;
  }

  if (!blogId) {
    throw new Error(
      "blogId or url required. Example:\n" +
        "  npm run test:create-neighbor -- --blogId=someBlogId\n" +
        "  npm run test:create-neighbor -- --url=https://m.blog.naver.com/someBlogId\n" +
        "  WORKER_TEST_NEIGHBOR_BLOG_ID=... npm run test:create-neighbor",
    );
  }

  if (!blogUrl) {
    blogUrl = `https://m.blog.naver.com/${blogId}`;
  }

  return { blogId, blogUrl };
}

function resolveDraftBody(): string | null {
  const fromArg =
    argValue("body") ?? argValue("draft") ?? argValue("message");
  const fromEnv =
    process.env.WORKER_TEST_NEIGHBOR_BODY?.trim() ||
    process.env.WORKER_TEST_DRAFT_BODY?.trim() ||
    "";
  const body = (fromArg || fromEnv || DEFAULT_MESSAGE).trim();
  return body || null;
}

function buildTargetRef(
  blogId: string,
  blogUrl: string,
): Record<string, unknown> {
  return {
    blog_id: blogId,
    blog_url: blogUrl,
    worker_test: true,
    smoke: "cdp_worker_neighbor_request",
  };
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
        next_action: "neighbor_request",
        priority: 5,
        goal: "cdp_worker_test_neighbor_request",
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
      display_name: `[cdp-worker:test-neighbor] ${stamp}`,
      discover_meta: {
        worker_test: true,
        purpose: "cdp_worker_neighbor_request",
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
      next_action: "neighbor_request",
      priority: 5,
      goal: "cdp_worker_test_neighbor_request",
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
  const { blogId, blogUrl } = resolveBlogIdAndUrl();
  const draftBody = resolveDraftBody();
  const targetRef = buildTargetRef(blogId, blogUrl);
  const db = createServiceClient();

  const { personId, workflowId, created } = await resolvePersonAndWorkflow(db);

  const { data: job, error } = await db
    .from("action_jobs")
    .insert({
      parent_workflow_id: workflowId,
      person_id: personId,
      channel: "blog",
      action_type: "neighbor_request",
      // action_jobs_risk_matrix: comment/neighbor_request/threads_reply => high
      risk: "high",
      status: "planned",
      draft_body: draftBody,
      target_ref: targetRef,
      inbox_priority: 0,
    })
    .select("id, action_type, status, risk, draft_body, target_ref, created_at")
    .single();

  if (error) {
    throw new Error(`create action_job: ${error.message}`);
  }

  console.info("[test:create-neighbor] created", {
    jobId: job.id,
    action_type: job.action_type,
    status: job.status,
    risk: job.risk,
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
    "[test:create-neighbor] failed",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
