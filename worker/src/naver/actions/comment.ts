/**
 * CDP Worker comment executor.
 * Mirrors NaverBlogAdapter.comment selectors; does not modify like.ts.
 */

import type { BrowserContext, Page } from "playwright";

import {
  failureToErrorColumn,
  makeFailure,
  type ActionFailureDetail,
} from "../../jobs/actionFailure";
import { resolveLikePostUrl, type LikeTargetRef } from "./like";

export type CommentExecuteInput = {
  jobId: string;
  targetRef: LikeTargetRef;
  draftBody: string | null;
};

export type CommentExecuteResult =
  | { ok: true; jobId: string; url: string }
  | {
      ok: false;
      jobId: string;
      error: string;
      failure: ActionFailureDetail;
    };

function failComment(
  jobId: string,
  input: {
    error_code: string;
    error_message: string;
    failed_step: string;
    detail?: Record<string, unknown>;
    steps?: string[];
  },
): CommentExecuteResult {
  const failure = makeFailure(input);
  return {
    ok: false,
    jobId,
    error: failureToErrorColumn(failure),
    failure,
  };
}

const COMMENT_INPUT_SELECTORS = [
  "#naverComment__write_textarea",
  "#naverCommentwrite_textarea",
  'div.u_cbox_text[contenteditable="true"]',
  '[contenteditable="true"].u_cbox_text',
  "div.u_cbox_write_area [contenteditable='true']",
  "textarea.u_cbox_text",
  ".u_cbox_text",
  "textarea[placeholder*='댓글']",
];

const COMMENT_SUBMIT_SELECTORS = [
  "button.u_cbox_btn_upload",
  ".u_cbox_btn_upload",
  'button:has-text("등록")',
  'a:has-text("등록")',
];

function commentMaxMs(): number {
  return Number(process.env.WORKER_COMMENT_MAX_MS ?? 60_000) || 60_000;
}

function navTimeoutMs(budget: number): number {
  const env = Number(process.env.BROWSER_NAV_TIMEOUT_MS ?? 20_000) || 20_000;
  return Math.max(5_000, Math.min(env, budget - 5_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`comment timeout after ${ms}ms at ${label}`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function strRef(
  ref: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const v = ref[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function resolveCommentBody(
  draftBody: string | null | undefined,
  targetRef: LikeTargetRef,
): string | null {
  if (draftBody?.trim()) return draftBody.trim();
  const ref = targetRef ?? {};
  return strRef(ref, "comment_text", "draft", "body", "text", "comment");
}

function resolveCommentPageUrl(targetRef: LikeTargetRef): string | null {
  const postUrl = resolveLikePostUrl(targetRef);
  if (!postUrl) return null;

  const ref = targetRef ?? {};
  let blogId = strRef(ref, "blog_id", "blogId", "blogID");
  let logNo = strRef(ref, "log_no", "logNo", "post_id", "postId");

  if (postUrl) {
    const m = postUrl.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
    if (m) {
      blogId = blogId ?? decodeURIComponent(m[1]!);
      logNo = logNo ?? m[2]!;
    }
  }

  if (blogId && logNo) {
    return `https://m.blog.naver.com/CommentList.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}`;
  }
  return postUrl;
}

async function focusAndFillComment(page: Page, body: string): Promise<void> {
  console.info("[worker] comment step=hide_guide");
  await page.evaluate(() => {
    const guides = document.querySelectorAll(
      ".u_cbox_guide, [data-action='write#placeholder'], .u_cbox_guide_txt",
    );
    guides.forEach((el) => {
      const h = el as HTMLElement;
      h.style.display = "none";
      h.style.pointerEvents = "none";
      h.style.visibility = "hidden";
      h.setAttribute("aria-hidden", "true");
    });
  });

  const guide = page
    .locator(
      ".u_cbox_guide, [data-action='write#placeholder'], .u_cbox_write_box",
    )
    .first();
  if ((await guide.count().catch(() => 0)) > 0) {
    await guide.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await sleep(200);
  }

  console.info("[worker] comment step=find_input");
  const area = page.locator(COMMENT_INPUT_SELECTORS.join(", ")).first();
  await area.waitFor({ state: "attached", timeout: 15_000 });
  await area.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);

  let focused = false;
  try {
    await area.click({ force: true, timeout: 5_000 });
    focused = true;
  } catch {
    focused = false;
  }

  if (!focused) {
    await page.evaluate((sels) => {
      for (const sel of sels) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) continue;
        el.focus();
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return;
      }
    }, COMMENT_INPUT_SELECTORS);
  }

  await sleep(150);
  console.info("[worker] comment step=fill_begin");

  try {
    await area.fill(body, { timeout: 5_000, force: true });
  } catch {
    await area.evaluate((el) => {
      const node = el as HTMLElement;
      node.focus();
      if (
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLInputElement
      ) {
        node.value = "";
      } else {
        node.textContent = "";
      }
    });
    await page.keyboard.insertText(body);
  }

  const typed = await area
    .evaluate((el) => {
      if (
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLInputElement
      ) {
        return el.value;
      }
      return (el.textContent || "").trim();
    })
    .catch(() => "");

  console.info(
    `[worker] comment step=fill_done length=${typed.length} preview=${typed.slice(0, 40)}`,
  );
  if (!typed || typed.length < Math.min(2, body.length)) {
    throw new Error("comment input fill did not stick");
  }
}

async function clickSubmit(page: Page): Promise<boolean> {
  for (const sel of COMMENT_SUBMIT_SELECTORS) {
    const loc = page.locator(sel).first();
    const count = await loc.count().catch(() => 0);
    if (count === 0) continue;
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    console.info(`[worker] comment submit selector=${sel}`);
    await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await loc.click({ timeout: 8_000, noWaitAfter: true, force: true });
    return true;
  }

  // discover fallback
  const clicked = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("button, a, [role='button']"),
    );
    for (const el of nodes) {
      const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      const cls = (el.getAttribute("class") || "").toLowerCase();
      if (text === "등록" || cls.includes("u_cbox_btn_upload")) {
        (el as HTMLElement).click();
        return text || cls.slice(0, 40);
      }
    }
    return null;
  });
  if (clicked) {
    console.info(`[worker] comment submit discover=${clicked}`);
    return true;
  }
  return false;
}

async function verifyCommentSubmitted(
  page: Page,
  body: string,
): Promise<boolean> {
  // Prefer seeing our text appear in the comment list, or upload button disabled briefly.
  const snippet = body.slice(0, 24);
  const found = await page
    .locator(`text=${snippet}`)
    .first()
    .waitFor({ state: "visible", timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (found) return true;

  const busy = await page
    .locator(
      "button.u_cbox_btn_upload[disabled], .u_cbox_btn_upload.u_cbox_btn_upload_off",
    )
    .count()
    .catch(() => 0);
  return busy > 0;
}

async function runCommentOnPage(
  page: Page,
  jobId: string,
  pageUrl: string,
  body: string,
  budgetMs: number,
): Promise<CommentExecuteResult> {
  const steps: string[] = ["visit_start"];
  const navMs = navTimeoutMs(budgetMs);
  page.setDefaultTimeout(Math.min(12_000, navMs));
  page.setDefaultNavigationTimeout(navMs);

  console.info(
    `[worker] comment step=goto_begin job=${jobId} url=${pageUrl} timeoutMs=${navMs}`,
  );
  try {
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: navMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[worker] comment step=goto_failed job=${jobId} error=${message}`,
    );
    steps.push("goto");
    return failComment(jobId, {
      error_code: "GOTO_FAILED",
      error_message: `페이지 이동 실패: ${message}`,
      failed_step: "goto",
      steps,
      detail: { url: pageUrl },
    });
  }
  steps.push("goto", "post_loaded");
  console.info(
    `[worker] comment step=goto_done job=${jobId} url=${page.url()}`,
  );

  await sleep(600);
  const title = await page.title().catch(() => "");
  console.info(
    `[worker] comment page loaded job=${jobId} title=${title}`,
  );

  try {
    steps.push("comment_input_search");
    await focusAndFillComment(page, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[worker] comment step=input_failed job=${jobId} error=${message}`,
    );
    return failComment(jobId, {
      error_code: "COMMENT_INPUT_NOT_FOUND",
      error_message: `댓글 입력 실패: ${message}`,
      failed_step: "comment_input_search",
      steps,
      detail: {
        url: pageUrl,
        current_url: page.url(),
        page_title: title,
      },
    });
  }

  console.info(`[worker] comment step=submit_begin job=${jobId}`);
  steps.push("comment_submit");
  const submitted = await clickSubmit(page);
  if (!submitted) {
    console.error(`[worker] comment failed job=${jobId} reason=submit_missing`);
    return failComment(jobId, {
      error_code: "COMMENT_SUBMIT_NOT_FOUND",
      error_message: "댓글 등록 버튼을 찾지 못했습니다",
      failed_step: "comment_submit",
      steps,
      detail: { url: pageUrl, current_url: page.url(), page_title: title },
    });
  }
  console.info(`[worker] comment step=submit_clicked job=${jobId}`);
  await sleep(800);

  steps.push("verify");
  const ok = await verifyCommentSubmitted(page, body);
  if (!ok) {
    const errText = await page
      .locator("text=/로그인|오류|실패|작성할 수 없/")
      .first()
      .isVisible()
      .catch(() => false);
    if (errText) {
      console.error(`[worker] comment failed job=${jobId} reason=blocked`);
      return failComment(jobId, {
        error_code: "VERIFY_FAILED",
        error_message: "댓글 등록이 차단된 것으로 보입니다 (로그인/오류 UI)",
        failed_step: "verify",
        steps,
        detail: { url: pageUrl, current_url: page.url(), page_title: title },
      });
    }
    console.info(
      `[worker] comment verify soft-pass job=${jobId} (submit clicked, echo not confirmed)`,
    );
  } else {
    console.info(`[worker] comment verify ok job=${jobId}`);
  }

  console.info(`[worker] comment completed job=${jobId}`);
  return { ok: true, jobId, url: page.url() };
}

export async function executeComment(
  context: BrowserContext,
  input: CommentExecuteInput,
): Promise<CommentExecuteResult> {
  const { jobId, targetRef, draftBody } = input;
  const body = resolveCommentBody(draftBody, targetRef);
  if (!body) {
    console.error(`[worker] comment skip job=${jobId} reason=missing_draft`);
    return failComment(jobId, {
      error_code: "MISSING_DRAFT",
      error_message: "draft_body 또는 target_ref.comment_text가 필요합니다",
      failed_step: "visit_start",
    });
  }

  const pageUrl = resolveCommentPageUrl(targetRef);
  if (!pageUrl) {
    console.error(`[worker] comment skip job=${jobId} reason=missing_post_url`);
    return failComment(jobId, {
      error_code: "MISSING_POST_URL",
      error_message: "target_ref에 post_url 또는 blog_id+log_no가 필요합니다",
      failed_step: "visit_start",
    });
  }

  const budgetMs = commentMaxMs();
  console.info(
    `[worker] comment start job=${jobId} url=${pageUrl} maxMs=${budgetMs} bodyLen=${body.length}`,
  );

  const pageRef: { current: Page | null } = { current: null };
  const work = (async (): Promise<CommentExecuteResult> => {
    console.info(`[worker] comment step=newPage_begin job=${jobId}`);
    const p = await withTimeout(context.newPage(), 15_000, "context.newPage");
    pageRef.current = p;
    return runCommentOnPage(p, jobId, pageUrl, body, budgetMs);
  })();

  try {
    return await withTimeout(work, budgetMs, "executeComment_total");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] comment failed job=${jobId} error=${message}`);
    const isTimeout = /timeout/i.test(message);
    return failComment(jobId, {
      error_code: isTimeout ? "TIMEOUT" : "UNKNOWN",
      error_message: message,
      failed_step: isTimeout ? "verify" : "unknown",
      detail: { url: pageUrl },
    });
  } finally {
    const toClose = pageRef.current;
    if (toClose) {
      console.info(`[worker] comment step=page_close job=${jobId}`);
      await withTimeout(toClose.close(), 5_000, "page.close").catch(
        () => undefined,
      );
    }
  }
}
