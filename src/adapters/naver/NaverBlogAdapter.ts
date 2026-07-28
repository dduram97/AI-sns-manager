import type { Page } from "playwright";
import type {
  ChannelActionInput,
  ChannelActionResult,
  ChannelAdapter,
} from "../types";
import {
  classifyWorkerErrorText,
  failureToErrorColumn,
  makeFailure,
} from "../../lib/actionFailure";
import {
  getNaverBrowserSession,
  type BrowserSessionManager,
} from "../browser/BrowserSessionManager";
import { ensureNaverLogin, probeNaverLoginState } from "./login";
import { writeSessionHealth } from "./sessionHealth";
import { resolveNaverTarget } from "./target";
import {
  applyAdapterDelay,
  sleep,
  waitUntil,
  type NaverDelayKind,
} from "./timing";
import type { NaverPostSnapshot } from "./posts";
import { scrapeLatestPostLinks, scrapePostDetail } from "./scrape";
import {
  scrapeOwnBuddyList,
  type NaverBuddyListItem,
} from "./buddyList";
import {
  clickSympathyIfOff,
  probeSympathyButton,
  waitForSympathyArea,
} from "./sympathy";
import {
  holdBrowserForDebug,
  isLikeDebugEnabled,
} from "./likeClickDebug";
import {
  clickCommentSubmit,
  commentDebug,
  probeLoginRequired,
  resolveCommentPageUrl,
  verifyCommentSubmitted,
  waitForCommentInput,
  COMMENT_INPUT_SELECTORS,
} from "./commentHelpers";
import {
  traceEnter,
  traceReturn,
  traceBlocked,
  traceSetCondition,
} from "./traceSummary";

/** live = Playwright automation · mock = log-only (no browser) */
export type NaverAdapterMode = "live" | "mock";

export function resolveNaverAdapterMode(): NaverAdapterMode {
  const raw = (process.env.NAVER_ADAPTER_MODE ?? "live").toLowerCase();
  return raw === "mock" ? "mock" : "live";
}

type ValidatedTarget = ReturnType<typeof resolveNaverTarget>;

function validateVisitTarget(
  input: ChannelActionInput,
): ChannelActionResult | ValidatedTarget {
  const target = resolveNaverTarget(input);
  if (!target.blogUrl && !target.blogId) {
    return {
      ok: false,
      errorMessage:
        "NaverBlogAdapter.visit: target_ref needs blog_id or blog_url",
    };
  }
  return target;
}

function validateLikeTarget(
  input: ChannelActionInput,
): ChannelActionResult | ValidatedTarget {
  const target = resolveNaverTarget(input);
  if (!target.postUrl) {
    return {
      ok: false,
      errorMessage:
        "NaverBlogAdapter.like: target_ref needs post_url or blog_id+log_no/post_id",
    };
  }
  return target;
}

function validateCommentTarget(
  input: ChannelActionInput,
): ChannelActionResult | (ValidatedTarget & { body: string }) {
  const target = resolveNaverTarget(input);
  const body = input.draftBody?.trim();
  if (!target.postUrl) {
    return {
      ok: false,
      errorMessage:
        "NaverBlogAdapter.comment: target_ref needs post_url or blog_id+log_no",
    };
  }
  if (!body) {
    return {
      ok: false,
      errorMessage: "NaverBlogAdapter.comment: draft_body is empty",
    };
  }
  return { ...target, body };
}

function validateMutualTarget(
  input: ChannelActionInput,
): ChannelActionResult | ValidatedTarget {
  const target = resolveNaverTarget(input);
  if (!target.blogUrl && !target.blogId) {
    return {
      ok: false,
      errorMessage:
        "NaverBlogAdapter.mutual_request: target_ref needs blog_id or blog_url",
    };
  }
  return target;
}

function isFailResult(
  v:
    | ChannelActionResult
    | ValidatedTarget
    | (ValidatedTarget & { body: string }),
): v is ChannelActionResult {
  return "ok" in v && (v as ChannelActionResult).ok === false;
}

async function withPage<T>(
  session: BrowserSessionManager,
  label: string,
  fn: (page: Page) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  if (label === "like") {
    traceEnter("withPage(like)");
  }
  return session.runWithTimeout(
    label,
    async () => {
    if (label === "like") {
      console.log(`[TRACE] withPage(like) acquirePage+timeout wrapper running`);
    }
    let page: Page | null = null;
    let ephemeral = true;
    let failed = false;
    let failReason = "";
    try {
      const acquired = await session.acquireWorkPage();
      page = acquired.page;
      ephemeral = acquired.ephemeral;
      if (label === "like") {
        console.log(`[TRACE] withPage(like) calling ensureNaverLogin`);
      }
      await ensureNaverLogin(session, page);
      const loginState = session.getLoginState();
      if (label === "like") {
        traceSetCondition("loginState", loginState);
        traceSetCondition("needsRelogin", loginState !== "logged_in");
      }
      if (loginState !== "logged_in") {
        const msg =
          session.getLastError() ??
          "NaverBlogAdapter: login required before action";
        traceBlocked("needs_relogin", `loginState=${loginState} detail=${msg}`);
        writeSessionHealth("needs_relogin", msg);
        throw new Error(msg);
      }
      if (label === "like") {
        console.log(`[TRACE] withPage(like) login ok — calling page fn`);
      }
      const out = await fn(page);
      if (label === "like") {
        traceReturn("withPage(like)", "withPage_fn_ok");
      }
      return out;
    } catch (err) {
      failed = true;
      failReason = err instanceof Error ? err.message : String(err);
      const msg = failReason;
      if (/relogin|login|session|captcha|expired/i.test(msg)) {
        writeSessionHealth("needs_relogin", msg);
        session.setLoginState("error", msg);
      }
      if (isLikeDebugEnabled() && label === "like") {
        await holdBrowserForDebug(`withPage-catch:${failReason}`).catch(
          () => undefined,
        );
      }
      if (label === "like") {
        const reason = /Executable doesn't exist|launch failed|browser/i.test(
          failReason,
        )
          ? "browser_launch_failed"
          : /relogin|login|session|captcha|expired/i.test(failReason)
            ? "needs_relogin"
            : "withPage_throw";
        traceSetCondition(
          "browserLaunchFailed",
          /Executable doesn't exist|launch failed/i.test(failReason),
        );
        traceReturn("withPage(like)", reason, failReason.slice(0, 200));
      }
      throw err;
    } finally {
      await session.saveCookies();
      if (failed && isLikeDebugEnabled() && label === "like") {
        console.log(
          `[NaverBlogAdapter] debug hold done — releasing page (reason=${failReason.slice(0, 120)})`,
        );
      }
      if (label === "like") {
        console.log(
          `[TRACE] withPage(like) finally releaseWorkPage ephemeral=${ephemeral}`,
        );
      }
      await session.releaseWorkPage(page, ephemeral);
    }
  },
    timeoutMs,
  );
}

async function clickFirst(
  page: Page,
  selectors: string[],
  opts?: { timeout?: number },
): Promise<boolean> {
  const timeout = opts?.timeout ?? 8_000;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) === 0) continue;
      await loc.scrollIntoViewIfNeeded({ timeout });
      await loc.click({ timeout });
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

type BuddyAddKind = "mutual" | "one_way_only" | "none";

/** Visible button scan — avoids body.innerText false positives (이웃추가 in nav). */
async function probeBuddyAddKind(page: Page): Promise<BuddyAddKind> {
  return page.evaluate(`(() => {
    function visible(el) {
      if (!el) return false;
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    var hasMutual = false;
    var hasOneWay = false;
    var nodes = document.querySelectorAll('a, button');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      var t = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, '');
      if (t.indexOf('서로이웃추가') >= 0) hasMutual = true;
      if (t.indexOf('이웃추가') >= 0 && t.indexOf('서로이웃') < 0) hasOneWay = true;
    }
    if (hasMutual) return 'mutual';
    if (hasOneWay) return 'one_way_only';
    return 'none';
  })()`) as Promise<BuddyAddKind>;
}

async function probeMutualOptionInForm(page: Page): Promise<boolean> {
  await page
    .locator('label:has-text("서로이웃"), label:has-text("이웃으로 추가")')
    .first()
    .waitFor({ state: "attached", timeout: 8_000 })
    .catch(() => undefined);
  return page.evaluate(`(() => {
    var body = ((document.body && document.body.innerText) || '');
    if (/서로이웃을\\s*신청|서로이웃추가/.test(body)) return true;
    var nodes = document.querySelectorAll('label, input[type="radio"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var t = ((el.innerText || el.textContent || el.value || '') + '');
      if (/서로이웃/.test(t)) return true;
    }
    return false;
  })()`) as Promise<boolean>;
}

/**
 * Focus/fill Naver comment input.
 * `.u_cbox_guide` often intercepts clicks on the contenteditable — hide it first,
 * then force-click / programmatic focus, then fill or insertText.
 */
async function focusAndFillNaverComment(
  page: Page,
  body: string,
): Promise<void> {
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

  // Tapping the guide itself sometimes activates the editor on Naver UI.
  const guide = page
    .locator(
      ".u_cbox_guide, [data-action='write#placeholder'], .u_cbox_write_box",
    )
    .first();
  if ((await guide.count()) > 0) {
    await guide.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await sleep(200);
  }

  const area = page
    .locator(COMMENT_INPUT_SELECTORS.join(", "))
    .first();
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

  const tagName = await area.evaluate((el) => el.tagName.toLowerCase());
  const isEditable =
    tagName === "textarea" ||
    tagName === "input" ||
    (await area.getAttribute("contenteditable")) === "true";

  if (!isEditable) {
    throw new Error("Naver comment input not editable");
  }

  // Prefer Playwright fill (works on contenteditable); fall back to DOM + insertText.
  try {
    await area.fill(body, { timeout: 5_000, force: true });
  } catch {
    await area.evaluate((el) => {
      const node = el as HTMLElement;
      node.focus();
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        node.value = "";
      } else {
        node.textContent = "";
        node.innerHTML = "";
      }
    });
    await page.keyboard.insertText(body);
  }

  // Ensure content landed (some Naver UIs ignore fill on contenteditable).
  const written = await area.evaluate((el) => {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return el.value.trim();
    }
    return (el.textContent ?? "").trim();
  });
  if (!written) {
    await area.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    await page.keyboard.insertText(body);
  }
}

function mockOk(action: string, externalRef?: string): ChannelActionResult {
  console.log(`[NaverBlogAdapter:mock] ${action} executed`);
  return { ok: true, externalRef };
}

function likeDebug(jobId: string, fields: Record<string, unknown>): void {
  console.info("[LIKE_DEBUG]", { job_id: jobId, ...fields });
}

function failStructured(input: {
  error_code: string;
  error_message: string;
  failed_step: string;
  detail?: Record<string, unknown>;
  steps?: string[];
}): ChannelActionResult {
  const failure = makeFailure(input);
  return {
    ok: false,
    errorMessage: failureToErrorColumn(failure),
    failure,
  };
}

function fail(err: unknown, fallbackStep = "unknown"): ChannelActionResult {
  const msg = err instanceof Error ? err.message : String(err);
  const failure = classifyWorkerErrorText(msg, fallbackStep);
  return {
    ok: false,
    errorMessage: failureToErrorColumn(failure),
    failure,
  };
}

/**
 * Naver Blog Browser Automation Adapter.
 * Actions: visit / like / comment / mutual_request (via follow → requestNeighbor)
 * Random delays are Adapter-local (timing.ts), not Policy/Decision.
 */
export class NaverBlogAdapter implements ChannelAdapter {
  readonly channel = "blog" as const;
  private readonly session: BrowserSessionManager;
  private readonly mode: NaverAdapterMode;

  constructor(session?: BrowserSessionManager, mode?: NaverAdapterMode) {
    this.session = session ?? getNaverBrowserSession();
    this.mode = mode ?? resolveNaverAdapterMode();
  }

  getMode(): NaverAdapterMode {
    return this.mode;
  }

  /** Soft probe without full credential login (Live ops). */
  async checkLoginReady(): Promise<{ ready: boolean; state: string }> {
    if (this.mode === "mock") return { ready: true, state: "mock" };
    const acquired = await this.session.acquireWorkPage();
    try {
      const state = await probeNaverLoginState(this.session, acquired.page);
      if (state === "logged_in") {
        this.session.setLoginState("logged_in");
        writeSessionHealth("logged_in");
        return { ready: true, state };
      }
      writeSessionHealth(state === "expired" ? "expired" : "logged_out");
      return { ready: false, state };
    } finally {
      await this.session.releaseWorkPage(acquired.page, acquired.ephemeral);
    }
  }

  private async beforeAction(kind: NaverDelayKind): Promise<void> {
    const ms = await applyAdapterDelay(kind);
    console.log(`[NaverBlogAdapter] delay ${kind}=${ms}ms mode=${this.mode}`);
  }

  async visit(input: ChannelActionInput): Promise<ChannelActionResult> {
    const validated = validateVisitTarget(input);
    if (isFailResult(validated)) return validated;
    const { blogUrl, blogId } = validated;
    const url = blogUrl ?? `https://m.blog.naver.com/${blogId}`;
    await this.beforeAction("visit");

    if (this.mode === "mock") return mockOk("Visit", url);

    try {
      await withPage(this.session, "visit", async (page) => {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.session.navigationTimeoutMs,
        });
        await sleep(400);
        await page.evaluate("window.scrollBy(0, 400)");
        await sleep(300);
      });
      console.log(`[NaverBlogAdapter:live] Visit executed → ${url}`);
      return { ok: true, externalRef: url };
    } catch (err) {
      return fail(err);
    }
  }

  async like(input: ChannelActionInput): Promise<ChannelActionResult> {
    traceEnter("NaverBlogAdapter.like", `mode=${this.mode}`);
    const jobId = input.job.id;
    const validated = validateLikeTarget(input);
    if (isFailResult(validated)) {
      traceBlocked("no_target", !validated.ok ? validated.errorMessage : "");
      traceSetCondition("targetFound", false);
      traceReturn("NaverBlogAdapter.like", "no_target");
      return validated;
    }
    traceSetCondition("targetFound", true);
    const { postUrl, blogId, logNo } = validated;
    await this.beforeAction("like");

    if (this.mode === "mock") {
      traceReturn("NaverBlogAdapter.like", "mock_mode");
      return mockOk("Like", postUrl!);
    }

    const steps: string[] = ["visit_start"];
    likeDebug(jobId, { target_url: postUrl, phase: "start" });

    try {
      /** already_liked | not_available | null */
      let likeSkip: "already_liked" | "not_available" | null = null;
      let likeMeta: Record<string, unknown> = {};
      await withPage(this.session, "like", async (page) => {
        console.log(
          `[TRACE] NaverBlogAdapter.like page.fn start url=${postUrl}`,
        );
        try {
          await page.goto(postUrl!, {
            waitUntil: "domcontentloaded",
            timeout: this.session.navigationTimeoutMs,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          likeDebug(jobId, { page_loaded: false, error: message });
          throw err;
        }
        steps.push("goto", "post_loaded");
        const pageUrl = page.url();
        const title = await page.title().catch(() => "");
        const loginRequired = await probeLoginRequired(page);
        likeDebug(jobId, {
          page_url_after_goto: pageUrl,
          title,
          login_status: loginRequired ? "required" : "ok",
        });
        if (loginRequired) {
          throw new Error("LOGIN_REQUIRED: 네이버 로그인이 필요합니다");
        }

        await sleep(250);
        await waitForSympathyArea(page, 12_000);

        const probe = await probeSympathyButton(page);
        likeDebug(jobId, {
          like_button_found: probe.state !== "missing" && Boolean(probe.locator),
          selector: probe.matchedSelector ?? null,
          before_state: probe.state,
        });
        console.log(
          `[NaverBlogAdapter:live] Like probe state=${probe.state} selector=${probe.matchedSelector ?? "none"} candidates=${probe.candidatesLogged.length}`,
        );
        traceSetCondition("adapterProbeState", probe.state);
        traceSetCondition("alreadyLiked", probe.state === "on");
        steps.push("like_button_search");

        if (probe.state === "on") {
          likeSkip = "already_liked";
          likeMeta = { already_liked: true, selector: probe.matchedSelector };
          traceBlocked("already_liked", "(adapter probe)");
          console.log(
            `[NaverBlogAdapter:live] Like skipped (already red heart) → ${postUrl}`,
          );
          return;
        }
        if (probe.state === "missing" || !probe.locator) {
          likeSkip = "not_available";
          traceBlocked("no_locator", `probe.state=${probe.state}`);
          console.info(
            `[NaverBlogAdapter:live] Like not_available (no button) → ${postUrl}`,
          );
          return;
        }

        console.log(`[TRACE] NaverBlogAdapter.like calling clickSympathyIfOff`);
        steps.push("like_click");
        const result = await clickSympathyIfOff(page);
        likeDebug(jobId, {
          click_result: result.clicked ? "clicked" : "not_clicked",
          verify_result: result.verifiedOn ? "on" : "off",
          selector: result.selector ?? probe.matchedSelector ?? null,
          error: result.error ?? null,
        });
        if (!result.clicked && !result.verifiedOn) {
          traceBlocked(
            "click_not_clickable",
            `clicked=${result.clicked} verifiedOn=${result.verifiedOn} error=${result.error}`,
          );
          throw new Error(
            `Like button not clickable${result.error ? `: ${result.error}` : ""}`,
          );
        }
        if (result.verifiedOn && !result.clicked) {
          likeSkip = "already_liked";
          likeMeta = {
            already_liked: true,
            selector: result.selector ?? probe.matchedSelector,
          };
          return;
        }

        console.log(
          `[NaverBlogAdapter:live] Like click via ${result.selector} redHeart=${result.verifiedOn} beforeShot=${result.beforeScreenshotPath ?? "n/a"}`,
        );

        if (!result.verifiedOn) {
          const hint = [
            result.beforeScreenshotPath
              ? `before=${result.beforeScreenshotPath}`
              : null,
            result.screenshotPath ? `after=${result.screenshotPath}` : null,
            "see .data/debug/sympathy/like_evidence.json",
          ]
            .filter(Boolean)
            .join(" ");
          traceBlocked("still_empty_heart", hint);
          throw new Error(
            `Like click did not register (still empty heart) ${hint}`,
          );
        }
        likeMeta = {
          already_liked: false,
          selector: result.selector ?? probe.matchedSelector,
          verified_on: true,
        };
        steps.push("verify");
        console.log(`[TRACE] NaverBlogAdapter.like page.fn success`);
      });

      if (likeSkip === "not_available") {
        traceReturn(
          "NaverBlogAdapter.like",
          "not_available",
          "LIKE_BUTTON_NOT_AVAILABLE",
        );
        return {
          ok: true,
          externalRef: postUrl!,
          outcome: "not_available",
          reasonCode: "LIKE_BUTTON_NOT_AVAILABLE",
          reasonMessage: "공감 버튼이 없는 글입니다.",
          failedStep: "button_search",
          steps,
          detail: { url: postUrl, blog_id: blogId, log_no: logNo },
        };
      }
      if (likeSkip === "already_liked") {
        traceReturn("NaverBlogAdapter.like", "already_liked", "skipped=true");
        return {
          ok: true,
          externalRef: postUrl!,
          skipped: true,
          steps,
          executionResult: {
            already_liked: true,
            url: postUrl,
            like: likeMeta,
          },
        };
      }
      console.log(
        `[NaverBlogAdapter:live] Like executed → ${postUrl} (${blogId ?? "?"}/${logNo ?? "?"})`,
      );
      traceReturn("NaverBlogAdapter.like", "like_ok");
      return {
        ok: true,
        externalRef: postUrl!,
        outcome: "executed",
        steps,
        executionResult: {
          already_liked: false,
          url: postUrl,
          like: likeMeta,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      traceReturn("NaverBlogAdapter.like", "like_throw", msg.slice(0, 200));
      if (/LOGIN_REQUIRED/i.test(msg)) {
        return failStructured({
          error_code: "LOGIN_REQUIRED",
          error_message: "네이버 로그인이 필요합니다",
          failed_step: "post_loaded",
          steps,
          detail: { url: postUrl },
        });
      }
      if (/not clickable/i.test(msg)) {
        return failStructured({
          error_code: "LIKE_CLICK_FAILED",
          error_message: msg,
          failed_step: "like_click",
          steps,
          detail: { url: postUrl },
        });
      }
      if (/still empty heart|did not register/i.test(msg)) {
        return failStructured({
          error_code: "LIKE_VERIFY_FAILED",
          error_message: msg,
          failed_step: "verify",
          steps,
          detail: { url: postUrl },
        });
      }
      return fail(err, "like_click");
    }
  }

  async comment(input: ChannelActionInput): Promise<ChannelActionResult> {
    const jobId = input.job.id;
    const validated = validateCommentTarget(input);
    if (isFailResult(validated)) return validated;
    const { postUrl, blogId, logNo, body } = validated;
    await this.beforeAction("comment");

    if (this.mode === "mock") return mockOk("Comment", postUrl!);

    const steps: string[] = ["visit_start"];
    const commentUrl = resolveCommentPageUrl({
      postUrl: postUrl!,
      blogId,
      logNo,
      targetRef: input.targetRef,
    });
    commentDebug(jobId, { url: commentUrl, phase: "start", body_len: body.length });

    try {
      let commentMeta: Record<string, unknown> = {};
      await withPage(this.session, "comment", async (page) => {
        try {
          await page.goto(commentUrl, {
            waitUntil: "domcontentloaded",
            timeout: this.session.navigationTimeoutMs,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          commentDebug(jobId, { page_loaded: false, error: message });
          throw err;
        }
        steps.push("goto", "post_loaded");
        await sleep(1_200);
        const pageUrl = page.url();
        const title = await page.title().catch(() => "");
        commentDebug(jobId, {
          page_loaded: true,
          page_url: pageUrl,
          title,
        });

        if (!/[?&]modal=comment/i.test(pageUrl) && /PostView|blog\.naver\.com/i.test(pageUrl)) {
          const next = pageUrl.includes("?")
            ? `${pageUrl}&modal=comment`
            : `${pageUrl}?modal=comment`;
          await page
            .goto(next, { waitUntil: "domcontentloaded", timeout: this.session.navigationTimeoutMs })
            .catch(() => undefined);
          await sleep(1_200);
          commentDebug(jobId, { page_url_after_modal: page.url() });
        }

        if (await probeLoginRequired(page)) {
          throw new Error("LOGIN_REQUIRED: 네이버 로그인이 필요합니다");
        }

        steps.push("comment_input_search");
        const inputSelector = await waitForCommentInput(page, 12_000);
        commentDebug(jobId, {
          comment_area_found: Boolean(inputSelector),
          input_selector: inputSelector,
        });
        if (!inputSelector) {
          throw new Error("COMMENT_INPUT_NOT_FOUND");
        }

        steps.push("fill_begin");
        await focusAndFillNaverComment(page, body);
        const filled = await page
          .locator(inputSelector)
          .first()
          .evaluate((el) => {
            if (
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLInputElement
            ) {
              return el.value.trim().length;
            }
            return (el.textContent ?? "").trim().length;
          })
          .catch(() => 0);
        commentDebug(jobId, {
          input_fill_result: filled > 0 ? `ok len=${filled}` : "empty",
        });
        if (!filled || filled < Math.min(2, body.length)) {
          throw new Error("COMMENT_FILL_FAILED");
        }

        steps.push("comment_submit");
        const submitted = await clickCommentSubmit(page);
        commentDebug(jobId, {
          submit_selector: submitted.selector,
          submit_click_result: submitted.ok ? "ok" : "failed",
        });
        if (!submitted.ok) {
          throw new Error("Comment submit button not found");
        }
        await sleep(1_200);

        steps.push("verify");
        const verified = await verifyCommentSubmitted(page, body);
        commentDebug(jobId, {
          verify_result: verified.ok ? "ok" : verified.detail,
        });
        if (!verified.ok) {
          throw new Error(`COMMENT_VERIFY_FAILED: ${verified.detail}`);
        }
        commentMeta = {
          url: commentUrl,
          input_selector: inputSelector,
          submit_selector: submitted.selector,
          verify_detail: verified.detail,
        };
      });
      console.log(`[NaverBlogAdapter:live] Comment executed → ${postUrl}`);
      return {
        ok: true,
        externalRef: postUrl!,
        steps,
        executionResult: {
          url: commentUrl,
          comment: commentMeta,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/LOGIN_REQUIRED/i.test(msg)) {
        return failStructured({
          error_code: "LOGIN_REQUIRED",
          error_message: "네이버 로그인이 필요합니다",
          failed_step: "post_loaded",
          steps,
          detail: { url: commentUrl },
        });
      }
      if (/COMMENT_INPUT_NOT_FOUND/i.test(msg)) {
        return failStructured({
          error_code: "COMMENT_INPUT_NOT_FOUND",
          error_message: "댓글 입력창을 찾지 못했습니다",
          failed_step: "comment_input_search",
          steps,
          detail: { url: commentUrl },
        });
      }
      if (/COMMENT_FILL_FAILED/i.test(msg)) {
        return failStructured({
          error_code: "COMMENT_FILL_FAILED",
          error_message: "댓글 입력창에 내용이 반영되지 않았습니다",
          failed_step: "fill_begin",
          steps,
          detail: { url: commentUrl },
        });
      }
      if (/submit button not found|COMMENT_SUBMIT/i.test(msg)) {
        return failStructured({
          error_code: "COMMENT_SUBMIT_FAILED",
          error_message: "댓글 등록 버튼을 찾지 못했거나 클릭에 실패했습니다",
          failed_step: "comment_submit",
          steps,
          detail: { url: commentUrl },
        });
      }
      if (/COMMENT_VERIFY_FAILED/i.test(msg)) {
        return failStructured({
          error_code: "COMMENT_VERIFY_FAILED",
          error_message: msg.replace(/^COMMENT_VERIFY_FAILED:\s*/, ""),
          failed_step: "verify",
          steps,
          detail: { url: commentUrl },
        });
      }
      if (/page\.goto|navigation|timeout/i.test(msg)) {
        return failStructured({
          error_code: "GOTO_FAILED",
          error_message: `페이지 이동 실패: ${msg}`,
          failed_step: "goto",
          steps,
          detail: { url: commentUrl },
        });
      }
      return fail(err, "comment_input_search");
    }
  }

  /** ChannelAdapter.follow ← ActionType neighbor_request (= mutual_request) */
  async follow(input: ChannelActionInput): Promise<ChannelActionResult> {
    return this.mutual_request(input);
  }

  /** Spec name: mutual_request / 서로이웃 신청 */
  async mutual_request(
    input: ChannelActionInput,
  ): Promise<ChannelActionResult> {
    return this.requestNeighbor(input);
  }

  async requestNeighbor(
    input: ChannelActionInput,
  ): Promise<ChannelActionResult> {
    const validated = validateMutualTarget(input);
    if (isFailResult(validated)) return validated;
    const { blogUrl, blogId } = validated;
    const url = blogUrl ?? `https://m.blog.naver.com/${blogId}`;
    const message =
      input.draftBody?.trim() ||
      "안녕하세요. 관심사가 비슷해 서로이웃 신청드립니다.";

    await this.beforeAction("mutual_request");

    if (this.mode === "mock") return mockOk("mutual_request", url);

    try {
      await withPage(this.session, "mutual_request", async (page) => {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.session.navigationTimeoutMs,
        });
        await sleep(1_200);

        const buddyKind = await probeBuddyAddKind(page);
        console.log(
          `[NaverBlogAdapter:live] mutual_request buddy_add_kind=${buddyKind} url=${page.url()}`,
        );

        const opened = await clickFirst(page, [
          'a:has-text("서로이웃추가")',
          'button:has-text("서로이웃추가")',
          'a:has-text("이웃추가")',
          'button:has-text("이웃추가")',
          ".add_buddy_btn",
          'a[href*="BuddyAdd"]',
          'a[href*="buddyadd"]',
        ]);
        if (!opened) {
          throw new Error("NEIGHBOR_BUTTON_NOT_AVAILABLE");
        }

        await sleep(800);

        if (buddyKind === "one_way_only") {
          const mutualInForm = await probeMutualOptionInForm(page);
          console.log(
            `[NaverBlogAdapter:live] mutual_request mutual_in_form=${mutualInForm}`,
          );
          if (!mutualInForm) {
            throw new Error("NEIGHBOR_MUTUAL_NOT_AVAILABLE");
          }
        }

        await clickFirst(page, [
          'input[type="radio"][value="1"]',
          'label:has-text("서로이웃")',
          "#bothBuddyRadio",
        ]);

        const msgBox = page
          .locator(
            "textarea, #message, textarea[name='message'], .buddy_add_msg textarea",
          )
          .first();
        if ((await msgBox.count()) > 0) {
          await msgBox.click({ timeout: 8_000 });
          await page.keyboard.insertText(message);
        }

        const confirmed = await clickFirst(page, [
          'button:has-text("확인")',
          'a:has-text("확인")',
          'button:has-text("신청")',
          'input[type="submit"]',
          ".btn_ok",
        ]);
        if (!confirmed) {
          throw new Error("Neighbor request confirm button not found");
        }
        await sleep(1_200);
      });
      console.log(`[NaverBlogAdapter:live] mutual_request executed → ${url}`);
      return { ok: true, externalRef: url };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/NEIGHBOR_BUTTON_NOT_AVAILABLE|button not found/i.test(msg)) {
        return {
          ok: true,
          externalRef: url,
          outcome: "excluded",
          reasonCode: "NEIGHBOR_BUTTON_NOT_AVAILABLE",
          reasonMessage: "서로이웃 신청 버튼 없음",
        };
      }
      if (/NEIGHBOR_MUTUAL_NOT_AVAILABLE/i.test(msg)) {
        return {
          ok: true,
          externalRef: url,
          outcome: "excluded",
          reasonCode: "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
          reasonMessage: "서로이웃이 불가한 블로그입니다.",
        };
      }
      if (/ALREADY_NEIGHBOR|already neighbor/i.test(msg)) {
        return {
          ok: true,
          externalRef: url,
          outcome: "excluded",
          reasonCode: "ALREADY_NEIGHBOR",
          reasonMessage: "이미 이웃인 블로그입니다.",
        };
      }
      return fail(err);
    }
  }

  /**
   * Probe mutual-neighbor relation on a blog (read-only — does not click 신청).
   * Uses same CDP/browser session as requestNeighbor.
   */
  async checkNeighborRelation(input: {
    blogId?: string | null;
    blogUrl?: string | null;
  }): Promise<{
    ok: boolean;
    result: import("@/domain/neighbor/relationStatus").NeighborRelationProbeResult;
    errorMessage?: string;
  }> {
    const blogId = input.blogId?.trim() || null;
    const blogUrl =
      input.blogUrl?.trim() ||
      (blogId ? `https://m.blog.naver.com/${blogId}` : null);
    if (!blogUrl) {
      return {
        ok: false,
        result: "unknown",
        errorMessage: "blog_id / blog_url required",
      };
    }

    if (this.mode === "mock") {
      return { ok: true, result: "pending_request" };
    }

    try {
      const result = await withPage(
        this.session,
        "neighbor_status_check",
        async (page) => {
          await page.goto(blogUrl, {
            waitUntil: "domcontentloaded",
            timeout: this.session.navigationTimeoutMs,
          });
          await sleep(1_000);

          const bodyText = ((await page.locator("body").innerText().catch(() => "")) || "")
            .replace(/\s+/g, " ")
            .trim();

          const hasAddBuddy =
            (await page
              .locator(
                'a:has-text("서로이웃추가"), button:has-text("서로이웃추가"), a:has-text("이웃추가"), button:has-text("이웃추가"), .add_buddy_btn, a[href*="BuddyAdd"], a[href*="buddyadd"]',
              )
              .count()
              .catch(() => 0)) > 0;

          const hasCancelRequest =
            /신청\s*취소|수락\s*대기|신청\s*중|서로이웃\s*신청/.test(bodyText) ||
            (await page
              .locator(
                'a:has-text("신청취소"), button:has-text("신청취소"), a:has-text("수락 대기")',
              )
              .count()
              .catch(() => 0)) > 0;

          const hasUnbuddy =
            /이웃\s*취소|서로이웃\s*취소|이웃삭제|서로이웃\s*끊기/.test(
              bodyText,
            ) ||
            (await page
              .locator(
                'a:has-text("이웃취소"), button:has-text("이웃취소"), a:has-text("서로이웃취소"), button:has-text("서로이웃취소")',
              )
              .count()
              .catch(() => 0)) > 0;

          if (hasUnbuddy) return "accepted" as const;
          if (hasCancelRequest && !hasAddBuddy) return "pending_request" as const;
          if (hasAddBuddy) return "can_request" as const;
          if (/서로이웃|이웃입니다|이미\s*이웃/.test(bodyText) && !hasAddBuddy) {
            return "accepted" as const;
          }
          return "unknown" as const;
        },
      );
      console.log(
        `[NaverBlogAdapter:live] neighbor_status_check → ${result} · ${blogUrl}`,
      );
      return { ok: true, result };
    } catch (err) {
      return {
        ok: false,
        result: "unknown",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Sync latest posts for a blogId (management target).
   * Used by Agent Tick perception ingest — not Decision Engine.
   */
  async fetchLatestPosts(
    blogId: string,
    limit = 5,
  ): Promise<NaverPostSnapshot[]> {
    await this.beforeAction("sync");
    const id = blogId.trim();
    if (!id) return [];

    if (this.mode === "mock") {
      console.log(`[NaverBlogAdapter:mock] fetchLatestPosts blogId=${id}`);
      if (process.env.NAVER_SYNC_MOCK_POST === "1") {
        const logNo = `mock${Date.now()}`;
        return [
          {
            blogId: id,
            logNo,
            postUrl: `https://m.blog.naver.com/${id}/${logNo}`,
            title: "mock sync post",
            contentRaw: "mock content for agent loop verify",
            contentSummary: "mock content for agent loop verify",
            publishedAt: new Date().toISOString(),
          },
        ].slice(0, limit);
      }
      return [];
    }

    return withPage(this.session, `sync:${id}`, async (page) => {
      const links = await scrapeLatestPostLinks(page, id, limit);
      const posts: NaverPostSnapshot[] = [];
      for (const link of links) {
        try {
          const detail = await scrapePostDetail(page, id, link);
          posts.push(detail);
        } catch (err) {
          console.warn(
            `[NaverBlogAdapter] post scrape failed ${link.postUrl}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      console.log(
        `[NaverBlogAdapter:live] sync posts blogId=${id} count=${posts.length}`,
      );
      return posts;
    });
  }

  /**
   * Read-only: scrape existing neighbors from the logged-in account's BuddyList.
   * Does not request/cancel neighbors or touch ActionJob execute.
   */
  async listExistingNeighbors(opts?: {
    ownBlogId?: string;
    maxItems?: number;
  }): Promise<{
    ok: boolean;
    ownBlogId: string | null;
    items: NaverBuddyListItem[];
    errorMessage?: string;
    debug?: import("./buddyList").BuddyListScrapeDebug;
  }> {
    if (this.mode === "mock") {
      const own =
        opts?.ownBlogId?.trim() ||
        process.env.NAVER_BLOG_ID?.trim() ||
        "mock_own_blog";
      return {
        ok: true,
        ownBlogId: own,
        items: [
          {
            blogId: "mock_buddy_1",
            blogName: "목업이웃1",
            blogUrl: "https://m.blog.naver.com/mock_buddy_1",
            relationKind: "mutual",
          },
          {
            blogId: "mock_buddy_2",
            blogName: "목업이웃2",
            blogUrl: "https://m.blog.naver.com/mock_buddy_2",
            relationKind: "neighbor",
          },
        ],
        debug: {
          ownBlogId: own,
          ownBlogIdSource: "mock",
          loginOk: true,
          pages: [],
          reasons: ["mock mode"],
          extractedBlogs: 2,
        },
      };
    }

    try {
      // Buddy list scroll can take several minutes for large neighbor sets
      const result = await withPage(
        this.session,
        "buddy_list_sync",
        async (page) => scrapeOwnBuddyList(page, opts),
        5 * 60_000,
      );
      return {
        ok: true,
        ownBlogId: result.ownBlogId,
        items: result.items,
        debug: result.debug,
      };
    } catch (err) {
      return {
        ok: false,
        ownBlogId: null,
        items: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * ChannelAdapter.sync — session warm-up.
   * Prefer fetchLatestPosts() from the sync worker for Perception ingest.
   */
  async sync(input?: ChannelActionInput): Promise<ChannelActionResult> {
    await this.beforeAction("sync");
    const blogId =
      typeof input?.targetRef?.blog_id === "string"
        ? input.targetRef.blog_id
        : typeof input?.targetRef?.blogId === "string"
          ? input.targetRef.blogId
          : null;

    if (this.mode === "mock") {
      return mockOk(blogId ? `Sync blog=${blogId}` : "Sync");
    }

    try {
      if (blogId) {
        const posts = await this.fetchLatestPosts(
          blogId,
          Number(input?.targetRef?.limit ?? 5) || 5,
        );
        return {
          ok: true,
          externalRef: `posts=${posts.length};blog=${blogId}`,
        };
      }

      await withPage(this.session, "sync", async (page) => {
        await page.goto("https://m.blog.naver.com/", {
          waitUntil: "domcontentloaded",
          timeout: this.session.navigationTimeoutMs,
        });
        await sleep(500);
      });
      console.log("[NaverBlogAdapter:live] Sync executed (session)");
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  }
}
