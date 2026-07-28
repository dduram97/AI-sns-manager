/**
 * Ops quality checks (no DB / no browser):
 * 1) failure payload parse → admin-facing fields
 * 2) failed statuses excluded from success count helper
 * 3) neighbor verify rejects soft_pass / unchanged relation
 * 4) comment mock drafts: low repetition across 10 samples
 *
 * Run: npx tsx scripts/verify-ops-quality.ts
 */

import { parseActionJobFailure } from "../src/lib/actionJobFailure";
import { generateCommentDraft } from "../src/services/commentDraftService";
import { interpretNeighborVerify } from "../worker/src/naver/actions/neighborRequest";
import {
  failureToErrorColumn,
  makeFailure,
} from "../worker/src/jobs/actionFailure";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function countSuccessOnly(statuses: string[]): number {
  return statuses.filter((s) => s === "executed").length;
}

async function main() {
  // 1) structured failure → UI parse
  const failure = makeFailure({
    error_code: "NEIGHBOR_BUTTON_NOT_AVAILABLE",
    error_message: "서로이웃 신청 버튼 없음",
    failed_step: "button_search",
    detail: { url: "https://m.blog.naver.com/demo" },
    steps: ["page_loaded", "relation_detect", "button_search"],
    retryable: false,
  });
  const errorCol = failureToErrorColumn(failure);
  const parsed = parseActionJobFailure({
    error: errorCol,
    targetRef: { execution_failure: failure },
  });
  assert(parsed, "parsed failure missing");
  assert(parsed.errorCode === "NEIGHBOR_BUTTON_NOT_AVAILABLE", "error code");
  assert(parsed.failedStep === "button_search", "failed step");
  assert(parsed.retryable === false, "retryable false for button missing");
  console.info("[ok] failure parse/display", parsed.summary);

  // 1b) soft skip like button
  const likeSkip = parseActionJobFailure({
    error: "[LIKE_BUTTON_NOT_AVAILABLE] 공감 버튼이 없는 게시글 @button_search",
    targetRef: {
      execution_result: {
        outcome: "not_available",
        reason_code: "LIKE_BUTTON_NOT_AVAILABLE",
        reason_message: "공감 버튼이 없는 게시글",
        failed_step: "button_search",
      },
    },
    status: "skipped",
  });
  assert(likeSkip, "like skip parse");
  assert(likeSkip.kind === "skipped", "like skip kind");
  assert(likeSkip.errorCode === "LIKE_BUTTON_NOT_AVAILABLE", "like code");
  console.info("[ok] like soft-skip parse", likeSkip.summary);

  // 2) completed count excludes failed
  const statuses = [
    "executed",
    "failed",
    "executed",
    "skipped",
    "excluded",
    "cancelled",
    "planned",
    "approved",
    "permanently_failed",
  ];
  const success = countSuccessOnly(statuses);
  assert(success === 2, `expected 2 executed, got ${success}`);
  console.info("[ok] success count excludes failed/skipped/excluded");

  // 3) neighbor verify — no soft pass
  const soft = interpretNeighborVerify({
    relation: "unknown",
    bodyText: "일반 본문",
  });
  assert(!soft.ok, "soft_pass must fail");
  assert(soft.error_code === "VERIFY_FAILED", "verify code");

  const pending = interpretNeighborVerify({
    relation: "pending_request",
    bodyText: "",
  });
  assert(pending.ok, "pending_request should succeed");

  const accepted = interpretNeighborVerify({
    relation: "accepted",
    bodyText: "",
  });
  assert(accepted.ok, "accepted should succeed");
  console.info("[ok] neighbor verify success/fail rules");

  // 4) comment drafts — repetition rate
  process.env.COMMENT_AI_PROVIDER = "mock";
  const titles = [
    "주말 카페 산책",
    "강아지랑 한강",
    "제주 여행 기록",
    "된장찌개 레시피",
    "육아 일기 오늘",
    "책상 정리 팁",
    "비 오는 날 풍경",
    "고양이 낮잠",
    "부산 해운대",
    "간단 아침 메뉴",
  ];
  const situations = [
    "공감",
    "맛집",
    "여행",
    "정보",
    "공감",
    "맛집",
    "여행",
    "정보",
    "공감",
    "맛집",
  ] as const;
  const bodies: string[] = [];
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i]!;
    const draft = await generateCommentDraft({
      title,
      content: `${title} 사진과 짧은 기록`,
      styleExamples: [],
      variant: "neighbor_feed",
      situation: situations[i],
    });
    assert(draft.body.length > 0, "empty draft");
    assert(draft.body.length <= 60, `draft too long: ${draft.body}`);
    bodies.push(draft.body);
  }
  const unique = new Set(bodies);
  const repeatRate = 1 - unique.size / bodies.length;
  assert(repeatRate <= 0.5, `repeat rate too high: ${repeatRate}`);
  console.info("[ok] comment drafts", {
    count: bodies.length,
    unique: unique.size,
    repeatRate,
    samples: bodies.slice(0, 3),
  });

  console.info("verify-ops-quality: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
