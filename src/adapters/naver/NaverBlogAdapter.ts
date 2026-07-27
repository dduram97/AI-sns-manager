import type { Page } from "playwright";
import type {
  ChannelActionInput,
  ChannelActionResult,
  ChannelAdapter,
} from "../types";
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

/** Naver mobile comment box selectors (contenteditable + textarea fallbacks). */
const NAVER_COMMENT_INPUT_SELECTORS = [
  "#naverComment__write_textarea",
  "#naverCommentwrite_textarea",
  'div.u_cbox_text[contenteditable="true"]',
  '[contenteditable="true"].u_cbox_text',
  "div.u_cbox_write_area [contenteditable='true']",
  "textarea.u_cbox_text",
  ".u_cbox_text",
  "textarea[placeholder*='댓글']",
];

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
    .locator(NAVER_COMMENT_INPUT_SELECTORS.join(", "))
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
    }, NAVER_COMMENT_INPUT_SELECTORS);
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

function fail(err: unknown): ChannelActionResult {
  return {
    ok: false,
    errorMessage: err instanceof Error ? err.message : String(err),
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

    try {
      let skipped = false;
      await withPage(this.session, "like", async (page) => {
        console.log(
          `[TRACE] NaverBlogAdapter.like page.fn start url=${postUrl}`,
        );
        await page.goto(postUrl!, {
          waitUntil: "domcontentloaded",
          timeout: this.session.navigationTimeoutMs,
        });
        // Sympathy area wait already polls UI — keep only a short settle.
        await sleep(250);
        await waitForSympathyArea(page, 12_000);

        const probe = await probeSympathyButton(page);
        console.log(
          `[NaverBlogAdapter:live] Like probe state=${probe.state} selector=${probe.matchedSelector ?? "none"} candidates=${probe.candidatesLogged.length}`,
        );
        traceSetCondition("adapterProbeState", probe.state);
        traceSetCondition("alreadyLiked", probe.state === "on");

        if (probe.state === "on") {
          skipped = true;
          traceBlocked("already_liked", "(adapter probe)");
          console.log(
            `[NaverBlogAdapter:live] Like skipped (already red heart) → ${postUrl}`,
          );
          // page fn returns; like() will RETURN already_liked
          return;
        }
        if (probe.state === "missing" || !probe.locator) {
          traceBlocked("no_locator", `probe.state=${probe.state}`);
          throw new Error("Like button not found (Naver UI may have changed)");
        }

        console.log(`[TRACE] NaverBlogAdapter.like calling clickSympathyIfOff`);
        const result = await clickSympathyIfOff(page);
        if (!result.clicked && !result.verifiedOn) {
          traceBlocked(
            "click_not_clickable",
            `clicked=${result.clicked} verifiedOn=${result.verifiedOn} error=${result.error}`,
          );
          throw new Error("Like button not clickable");
        }
        if (result.verifiedOn && !result.clicked) {
          skipped = true;
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
        console.log(`[TRACE] NaverBlogAdapter.like page.fn success`);
      });

      if (skipped) {
        traceReturn("NaverBlogAdapter.like", "already_liked", "skipped=true");
        return { ok: true, externalRef: postUrl!, skipped: true };
      }
      console.log(
        `[NaverBlogAdapter:live] Like executed → ${postUrl} (${blogId ?? "?"}/${logNo ?? "?"})`,
      );
      traceReturn("NaverBlogAdapter.like", "like_ok");
      return { ok: true, externalRef: postUrl! };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      traceReturn("NaverBlogAdapter.like", "like_throw", msg.slice(0, 200));
      return fail(err);
    }
  }

  async comment(input: ChannelActionInput): Promise<ChannelActionResult> {
    const validated = validateCommentTarget(input);
    if (isFailResult(validated)) return validated;
    const { postUrl, blogId, logNo, body } = validated;
    await this.beforeAction("comment");

    if (this.mode === "mock") return mockOk("Comment", postUrl!);

    try {
      await withPage(this.session, "comment", async (page) => {
        let commentUrl = postUrl!;
        if (blogId && logNo) {
          commentUrl = `https://m.blog.naver.com/CommentList.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}`;
        }

        await page.goto(commentUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.session.navigationTimeoutMs,
        });
        // Prefer comment-input readiness over fixed long sleep.
        await page
          .locator(NAVER_COMMENT_INPUT_SELECTORS.join(", "))
          .first()
          .waitFor({ state: "attached", timeout: 12_000 })
          .catch(() => undefined);
        await sleep(250);

        await focusAndFillNaverComment(page, body);
        await sleep(200);

        const submitted = await clickFirst(page, [
          "button.u_cbox_btn_upload",
          ".u_cbox_btn_upload",
          'button:has-text("등록")',
          'a:has-text("등록")',
        ]);
        if (!submitted) {
          throw new Error("Comment submit button not found");
        }
        // Confirm settle via short poll / networkidle instead of fixed 1s.
        const settled = await waitUntil(
          async () => {
            const busy = await page
              .locator(
                "button.u_cbox_btn_upload[disabled], .u_cbox_btn_upload.u_cbox_btn_upload_off",
              )
              .count()
              .catch(() => 0);
            return busy > 0;
          },
          { timeoutMs: 2_500, intervalMs: 150 },
        );
        if (!settled) {
          await page
            .waitForLoadState("networkidle", { timeout: 2_000 })
            .catch(() => undefined);
          await sleep(300);
        }
      });
      console.log(`[NaverBlogAdapter:live] Comment executed → ${postUrl}`);
      return { ok: true, externalRef: postUrl! };
    } catch (err) {
      return fail(err);
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
          throw new Error("Neighbor request button not found");
        }

        await sleep(800);

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
