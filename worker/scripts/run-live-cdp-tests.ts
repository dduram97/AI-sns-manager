/**
 * Live CDP worker smoke tests (no DB required for action logic).
 * Run: cd worker && node --import tsx scripts/run-live-cdp-tests.ts
 */

import { connectOverCdp, disconnectCdp } from "../src/browser/cdpClient";
import { checkNaverSession } from "../src/naver/naverSessionChecker";
import { executeLike } from "../src/naver/actions/like";
import { executeNeighborRequest } from "../src/naver/actions/neighborRequest";

type CaseResult = {
  name: string;
  ok: boolean;
  kind: string;
  reasonCode?: string;
  message?: string;
  url?: string;
  steps?: string[];
  detail?: Record<string, unknown>;
};

function summarizeLike(
  name: string,
  r: Awaited<ReturnType<typeof executeLike>>,
): CaseResult {
  if (r.ok === true) {
    return {
      name,
      ok: true,
      kind: r.alreadyLiked ? "executed_already_liked" : "executed",
      url: r.url,
    };
  }
  if (r.ok === "skipped") {
    return {
      name,
      ok: true,
      kind: "skipped",
      reasonCode: r.skip.reason_code,
      message: r.skip.reason_message,
      url: r.url,
      steps: r.skip.steps,
      detail: r.skip.detail,
    };
  }
  return {
    name,
    ok: false,
    kind: "failed",
    reasonCode: r.failure?.error_code,
    message: r.failure?.error_message ?? r.error,
    steps: r.failure?.steps,
    detail: r.failure?.detail,
  };
}

function summarizeNeighbor(
  name: string,
  r: Awaited<ReturnType<typeof executeNeighborRequest>>,
): CaseResult {
  if (r.ok === true) {
    return {
      name,
      ok: true,
      kind: r.alreadyNeighbor
        ? "executed_already_neighbor"
        : r.alreadyPending
          ? "executed_already_pending"
          : "executed",
      url: r.url,
    };
  }
  if (r.ok === "skipped") {
    return {
      name,
      ok: true,
      kind: "excluded",
      reasonCode: r.skip.reason_code,
      message: r.skip.reason_message,
      url: r.url,
      steps: r.skip.steps,
      detail: r.skip.detail,
    };
  }
  return {
    name,
    ok: false,
    kind: "failed",
    reasonCode: r.failure?.error_code,
    message: r.failure?.error_message ?? r.error,
    steps: r.failure?.steps,
    detail: r.failure?.detail,
  };
}

async function main() {
  console.info("[live-test] CDP + Naver session check…");
  const naver = await checkNaverSession();
  if (!naver.ok) {
    console.error("[live-test] Naver login FAILED:", naver);
    process.exit(1);
  }
  console.info("[live-test] Naver login OK");

  const conn = await connectOverCdp();
  const ctx = conn.context;
  const results: CaseResult[] = [];

  // 1) Like — button present
  results.push(
    summarizeLike(
      "like_ok",
      await executeLike(ctx, {
        jobId: "live-like-ok",
        targetRef: {
          post_url:
            "https://m.blog.naver.com/PostView.naver?blogId=soonim0127&logNo=222938389526&navType=by",
          blog_id: "soonim0127",
          log_no: "222938389526",
        },
      }),
    ),
  );

  // 2) Like — no button
  results.push(
    summarizeLike(
      "like_no_button",
      await executeLike(ctx, {
        jobId: "live-like-skip",
        targetRef: {
          post_url:
            "https://m.blog.naver.com/PostView.naver?blogId=soonim0127&logNo=222360273622&navType=by",
          blog_id: "soonim0127",
          log_no: "222360273622",
        },
      }),
    ),
  );

  const neighborMsg = "안녕하세요. 관심사가 비슷해 서로이웃 신청드립니다.";

  // 3A) Already neighbor
  results.push(
    summarizeNeighbor(
      "neighbor_already",
      await executeNeighborRequest(ctx, {
        jobId: "live-neighbor-already",
        targetRef: {
          blog_id: "soonim0127",
          blog_url: "https://m.blog.naver.com/soonim0127",
        },
        draftBody: neighborMsg,
      }),
    ),
  );

  // 3B) Mutual OK — blueday67000 (blog home)
  results.push(
    summarizeNeighbor(
      "neighbor_blueday67000",
      await executeNeighborRequest(ctx, {
        jobId: "live-neighbor-blueday",
        targetRef: {
          blog_id: "blueday67000",
          blog_url: "https://m.blog.naver.com/blueday67000",
        },
        draftBody: neighborMsg,
      }),
    ),
  );

  // 3B2) Mutual OK — gpal0904
  results.push(
    summarizeNeighbor(
      "neighbor_gpal0904",
      await executeNeighborRequest(ctx, {
        jobId: "live-neighbor-gpal",
        targetRef: {
          blog_id: "gpal0904",
          blog_url: "https://m.blog.naver.com/gpal0904",
        },
        draftBody: neighborMsg,
      }),
    ),
  );

  // 3C) One-way only — skybridges
  results.push(
    summarizeNeighbor(
      "neighbor_skybridges",
      await executeNeighborRequest(ctx, {
        jobId: "live-neighbor-sky",
        targetRef: {
          blog_id: "skybridges",
          blog_url: "https://m.blog.naver.com/skybridges",
        },
        draftBody: neighborMsg,
      }),
    ),
  );

  await disconnectCdp(conn);

  console.info("\n========== LIVE CDP TEST RESULTS ==========");
  for (const r of results) {
    console.info(JSON.stringify(r, null, 2));
  }

  const failed = results.filter((r) => r.kind === "failed");
  if (failed.length > 0) {
    console.error(`[live-test] ${failed.length} case(s) hard-failed`);
    process.exit(1);
  }
  console.info("[live-test] all cases completed (no hard failures)");
}

main().catch((err) => {
  console.error("[live-test] fatal", err);
  process.exit(1);
});
