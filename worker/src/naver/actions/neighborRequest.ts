/**
 * CDP Worker neighbor_request executor.
 * Mirrors NaverBlogAdapter.requestNeighbor; classic selectors + discover fallback.
 * Does not modify visit/like/comment executors.
 */

import type { BrowserContext, Page } from "playwright";

export type NeighborTargetRef = Record<string, unknown> | null | undefined;

export type NeighborExecuteInput = {
  jobId: string;
  targetRef: NeighborTargetRef;
  draftBody: string | null;
};

export type NeighborExecuteResult =
  | {
      ok: true;
      jobId: string;
      url: string;
      alreadyNeighbor: boolean;
      alreadyPending: boolean;
    }
  | { ok: false; jobId: string; error: string };

const DEFAULT_MESSAGE =
  "안녕하세요. 관심사가 비슷해 서로이웃 신청드립니다.";

/** Classic / known Naver buddy-add selectors — first probe. */
const OPEN_BUDDY_SELECTORS = [
  'a:has-text("서로이웃추가")',
  'button:has-text("서로이웃추가")',
  'a:has-text("이웃추가")',
  'button:has-text("이웃추가")',
  ".add_buddy_btn",
  'a[href*="BuddyAdd"]',
  'a[href*="buddyadd"]',
];

const MUTUAL_RADIO_SELECTORS = [
  'input[type="radio"][value="1"]',
  'label:has-text("서로이웃")',
  "#bothBuddyRadio",
];

const MESSAGE_SELECTORS = [
  "textarea",
  "#message",
  "textarea[name='message']",
  ".buddy_add_msg textarea",
];

const CONFIRM_SELECTORS = [
  'button:has-text("확인")',
  'a:has-text("확인")',
  'button:has-text("신청")',
  'input[type="submit"]',
  ".btn_ok",
];

function neighborMaxMs(): number {
  return Number(process.env.WORKER_NEIGHBOR_MAX_MS ?? 60_000) || 60_000;
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
      reject(new Error(`neighbor_request timeout after ${ms}ms at ${label}`));
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

function toMBlogUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    if (
      u.hostname === "blog.naver.com" ||
      u.hostname === "m.blog.naver.com" ||
      u.hostname.endsWith(".blog.naver.com")
    ) {
      u.protocol = "https:";
      u.hostname = "m.blog.naver.com";
      return u.toString();
    }
  } catch {
    // fall through
  }
  return trimmed
    .replace(/^https?:\/\/blog\.naver\.com\//i, "https://m.blog.naver.com/")
    .replace(
      /^https?:\/\/m\.blog\.naver\.com\//i,
      "https://m.blog.naver.com/",
    );
}

/** Extract blogId from a post or blog URL. */
export function extractBlogIdFromUrl(url: string): string | null {
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

export function resolveNeighborBlogId(
  targetRef: NeighborTargetRef,
): string | null {
  const ref = targetRef ?? {};
  const direct = strRef(ref, "blog_id", "blogId", "blogID");
  if (direct) return direct;

  for (const key of ["blog_url", "profile_url", "post_url", "url", "permalink"]) {
    const raw = strRef(ref, key);
    if (!raw) continue;
    const id = extractBlogIdFromUrl(raw);
    if (id) return id;
  }
  return null;
}

/** Resolve blog home URL for neighbor_request navigation. */
export function resolveNeighborBlogUrl(
  targetRef: NeighborTargetRef,
): string | null {
  const ref = targetRef ?? {};
  const blogId = resolveNeighborBlogId(ref);
  const blogUrl = strRef(ref, "blog_url", "profile_url");
  if (blogUrl) return toMBlogUrl(blogUrl);
  if (blogId) return `https://m.blog.naver.com/${blogId}`;

  const postUrl = strRef(ref, "post_url", "url", "permalink");
  if (postUrl) {
    const id = extractBlogIdFromUrl(postUrl);
    if (id) return `https://m.blog.naver.com/${id}`;
  }
  return null;
}

export function resolveNeighborMessage(
  draftBody: string | null,
  targetRef: NeighborTargetRef,
): string {
  const fromDraft = typeof draftBody === "string" ? draftBody.trim() : "";
  if (fromDraft) return fromDraft;
  const ref = targetRef ?? {};
  const fromRef = strRef(
    ref,
    "message",
    "comment_text",
    "draft",
    "body",
    "text",
  );
  return fromRef || DEFAULT_MESSAGE;
}

type RelationProbe = "accepted" | "pending_request" | "can_request" | "unknown";

async function probeRelation(page: Page): Promise<RelationProbe> {
  return page.evaluate(`(() => {
    function visible(el) {
      if (!el) return false;
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    var bodyText = ((document.body && document.body.innerText) || '')
      .replace(/\\s+/g, ' ')
      .trim();
    var addSels = [
      'a[href*="BuddyAdd"]',
      'a[href*="buddyadd"]',
      '.add_buddy_btn'
    ];
    var hasAddBuddy = false;
    for (var i = 0; i < addSels.length; i++) {
      var nodes = document.querySelectorAll(addSels[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (visible(nodes[j])) { hasAddBuddy = true; break; }
      }
      if (hasAddBuddy) break;
    }
    if (!hasAddBuddy) {
      var all = document.querySelectorAll('a, button');
      for (var k = 0; k < all.length; k++) {
        var t = ((all[k].innerText || all[k].textContent || '') + '').replace(/\\s+/g, '');
        if ((t.indexOf('서로이웃추가') >= 0 || t.indexOf('이웃추가') >= 0) && visible(all[k])) {
          hasAddBuddy = true;
          break;
        }
      }
    }
    var hasCancelRequest =
      /신청\\s*취소|수락\\s*대기|신청\\s*중|서로이웃\\s*신청/.test(bodyText);
    var hasUnbuddy =
      /이웃\\s*취소|서로이웃\\s*취소|이웃삭제|서로이웃\\s*끊기/.test(bodyText);
    if (hasUnbuddy) return 'accepted';
    if (hasCancelRequest && !hasAddBuddy) return 'pending_request';
    if (hasAddBuddy) return 'can_request';
    if (/서로이웃|이웃입니다|이미\\s*이웃/.test(bodyText) && !hasAddBuddy) {
      return 'accepted';
    }
    return 'unknown';
  })()`) as Promise<RelationProbe>;
}

async function clickFirstLocator(
  page: Page,
  selectors: string[],
): Promise<string | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const count = await loc.count().catch(() => 0);
    if (count <= 0) continue;
    try {
      await loc.click({ timeout: 5_000 });
      return sel;
    } catch {
      // try next
    }
  }
  return null;
}

/** Discover fallback: score visible a/button for buddy-add intent. */
const DISCOVER_OPEN_SOURCE = `(() => {
  function visible(el) {
    if (!el) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function xpathOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '//*[@id=\"' + el.id.replace(/\"/g, '\\\\\"') + '\"]';
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      var tag = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (!parent) break;
      var same = Array.prototype.filter.call(parent.children, function (c) {
        return c.tagName === cur.tagName;
      });
      var ix = same.indexOf(cur) + 1;
      parts.unshift(tag + '[' + ix + ']');
      cur = parent;
      if (parts.length > 12) break;
    }
    return '//' + parts.join('/');
  }
  function scoreEl(el) {
    var text = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
    var aria = (el.getAttribute('aria-label') || '') + '';
    var title = (el.getAttribute('title') || '') + '';
    var cls = (el.getAttribute('class') || '') + '';
    var href = (el.getAttribute('href') || '') + '';
    var blob = (text + ' ' + aria + ' ' + title + ' ' + cls + ' ' + href).toLowerCase();
    var score = 0;
    if (/서로이웃추가/.test(text) || /서로이웃추가/.test(aria)) score += 80;
    if (/이웃추가/.test(text) || /이웃추가/.test(aria)) score += 70;
    if (/buddyadd|buddyadd\\.naver|add_buddy|addbuddy/.test(blob)) score += 60;
    if (/서로이웃|이웃맺기|이웃신청/.test(text)) score += 40;
    if (/취소|끊기|삭제|관리/.test(text)) score -= 50;
    var r = el.getBoundingClientRect();
    if (r.width >= 8 && r.height >= 8) score += 5;
    if (r.width < 4 || r.height < 4) score -= 40;
    return score;
  }
  var nodes = Array.prototype.slice.call(
    document.querySelectorAll('a, button, [role=\"button\"], [class*=\"buddy\"], [href*=\"BuddyAdd\"], [href*=\"buddyadd\"]')
  );
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!visible(el)) continue;
    var sc = scoreEl(el);
    if (sc < 40) continue;
    if (sc > bestScore) {
      bestScore = sc;
      best = el;
    }
  }
  if (!best) return null;
  best.setAttribute('data-worker-neighbor-open', '1');
  return { score: bestScore, xpath: xpathOf(best), text: ((best.innerText || '') + '').slice(0, 40) };
})()`;

async function openBuddyForm(page: Page): Promise<"classic" | "discover" | null> {
  console.info("[worker] neighbor_request step=open_classic");
  const classic = await clickFirstLocator(page, OPEN_BUDDY_SELECTORS);
  if (classic) {
    console.info(`[worker] neighbor_request open classic=${classic}`);
    return "classic";
  }

  console.info("[worker] neighbor_request step=open_discover");
  const found = (await page.evaluate(DISCOVER_OPEN_SOURCE)) as {
    score: number;
    xpath: string;
    text: string;
  } | null;
  if (!found) return null;

  const marked = page.locator('[data-worker-neighbor-open="1"]').first();
  if ((await marked.count().catch(() => 0)) > 0) {
    await marked.click({ timeout: 5_000 });
    console.info(
      `[worker] neighbor_request open discover score=${found.score} text=${found.text}`,
    );
    return "discover";
  }

  if (found.xpath) {
    const byX = page.locator(`xpath=${found.xpath}`).first();
    if ((await byX.count().catch(() => 0)) > 0) {
      await byX.click({ timeout: 5_000 });
      console.info(
        `[worker] neighbor_request open discover xpath text=${found.text}`,
      );
      return "discover";
    }
  }
  return null;
}

async function fillAndConfirm(page: Page, message: string): Promise<boolean> {
  await sleep(800);

  const radio = await clickFirstLocator(page, MUTUAL_RADIO_SELECTORS);
  if (radio) {
    console.info(`[worker] neighbor_request mutual_radio=${radio}`);
  } else {
    console.info("[worker] neighbor_request mutual_radio=skipped");
  }

  const msgBox = page.locator(MESSAGE_SELECTORS.join(", ")).first();
  if ((await msgBox.count().catch(() => 0)) > 0) {
    try {
      await msgBox.click({ timeout: 5_000 });
      await msgBox.fill("");
      await page.keyboard.insertText(message);
      console.info(
        `[worker] neighbor_request message_filled length=${message.length}`,
      );
    } catch (err) {
      console.warn(
        `[worker] neighbor_request message_fill_warn ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    console.info("[worker] neighbor_request message_box=missing");
  }

  const confirmed = await clickFirstLocator(page, CONFIRM_SELECTORS);
  if (!confirmed) {
    // discover confirm
    const clicked = await page.evaluate(`(() => {
      function visible(el) {
        if (!el) return false;
        var s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      var nodes = document.querySelectorAll('a, button, input[type=\"submit\"]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        var t = ((el.innerText || el.textContent || el.value || '') + '').replace(/\\s+/g, '');
        if (t === '확인' || t === '신청' || t.indexOf('확인') === 0 || t.indexOf('신청') === 0) {
          el.click();
          return t.slice(0, 20);
        }
      }
      return null;
    })()`);
    if (!clicked) return false;
    console.info(`[worker] neighbor_request confirm discover=${clicked}`);
    return true;
  }
  console.info(`[worker] neighbor_request confirm classic=${confirmed}`);
  return true;
}

async function verifyAfterSubmit(page: Page): Promise<{
  ok: boolean;
  detail: string;
}> {
  await sleep(1_200);
  const relation = await probeRelation(page);
  if (relation === "pending_request" || relation === "accepted") {
    return { ok: true, detail: `relation=${relation}` };
  }

  const bodyText = (
    (await page.locator("body").innerText().catch(() => "")) || ""
  )
    .replace(/\s+/g, " ")
    .trim();

  if (/신청\s*(이\s*)?완료|신청했습니다|전송했습니다|접수/.test(bodyText)) {
    return { ok: true, detail: "success_copy" };
  }
  if (/이미\s*(서로)?이웃|이웃입니다/.test(bodyText)) {
    return { ok: true, detail: "already_neighbor_copy" };
  }
  if (/로그인|본인인증|차단|하루\s*제한|신청\s*불가|오류/.test(bodyText)) {
    return { ok: false, detail: "blocked_or_error_ui" };
  }

  // Soft-pass: confirm was clicked and no hard error — UI varies after submit.
  return { ok: true, detail: `soft_pass relation=${relation}` };
}

async function runNeighborOnPage(
  page: Page,
  jobId: string,
  pageUrl: string,
  message: string,
  budgetMs: number,
): Promise<NeighborExecuteResult> {
  const navMs = navTimeoutMs(budgetMs);
  console.info(
    `[worker] neighbor_request step=goto_begin job=${jobId} url=${pageUrl} timeoutMs=${navMs}`,
  );

  try {
    await withTimeout(
      page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: navMs }),
      navMs + 2_000,
      "goto",
    );
  } catch (err) {
    const messageErr = err instanceof Error ? err.message : String(err);
    console.error(
      `[worker] neighbor_request step=goto_failed job=${jobId} error=${messageErr}`,
    );
    return { ok: false, jobId, error: `goto failed: ${messageErr}` };
  }

  console.info(
    `[worker] neighbor_request step=goto_done job=${jobId} url=${page.url()}`,
  );
  await sleep(1_200);

  const before = await probeRelation(page);
  console.info(
    `[worker] neighbor_request relation_before=${before} job=${jobId}`,
  );

  if (before === "accepted") {
    console.info(
      `[worker] neighbor_request already_neighbor job=${jobId} → success`,
    );
    return {
      ok: true,
      jobId,
      url: pageUrl,
      alreadyNeighbor: true,
      alreadyPending: false,
    };
  }

  if (before === "pending_request") {
    console.info(
      `[worker] neighbor_request already_pending job=${jobId} → success`,
    );
    return {
      ok: true,
      jobId,
      url: pageUrl,
      alreadyNeighbor: false,
      alreadyPending: true,
    };
  }

  const opened = await openBuddyForm(page);
  if (!opened) {
    // Re-probe — UI may not expose add button when already neighbor.
    const again = await probeRelation(page);
    if (again === "accepted") {
      console.info(
        `[worker] neighbor_request already_neighbor_after_probe job=${jobId}`,
      );
      return {
        ok: true,
        jobId,
        url: pageUrl,
        alreadyNeighbor: true,
        alreadyPending: false,
      };
    }
    const err = "Neighbor request button not found";
    console.error(`[worker] neighbor_request failed job=${jobId} reason=${err}`);
    return { ok: false, jobId, error: err };
  }

  console.info(`[worker] neighbor_request step=submit_begin job=${jobId}`);
  const confirmed = await fillAndConfirm(page, message);
  if (!confirmed) {
    const err = "Neighbor request confirm button not found";
    console.error(`[worker] neighbor_request failed job=${jobId} reason=${err}`);
    return { ok: false, jobId, error: err };
  }
  console.info(`[worker] neighbor_request step=submit_clicked job=${jobId}`);

  const verified = await verifyAfterSubmit(page);
  console.info(
    `[worker] neighbor_request verify job=${jobId} ok=${verified.ok} detail=${verified.detail}`,
  );
  if (!verified.ok) {
    return {
      ok: false,
      jobId,
      error: `neighbor_request verify failed: ${verified.detail}`,
    };
  }

  console.info(
    `[worker] neighbor_request completed job=${jobId} detail=${verified.detail}`,
  );
  return {
    ok: true,
    jobId,
    url: pageUrl,
    alreadyNeighbor: verified.detail.includes("accepted") ||
      verified.detail === "already_neighbor_copy",
    alreadyPending: verified.detail.includes("pending"),
  };
}

export async function executeNeighborRequest(
  context: BrowserContext,
  input: NeighborExecuteInput,
): Promise<NeighborExecuteResult> {
  const { jobId, targetRef, draftBody } = input;
  const pageUrl = resolveNeighborBlogUrl(targetRef);
  if (!pageUrl) {
    console.error(
      `[worker] neighbor_request skip job=${jobId} reason=missing_blog_url`,
    );
    return {
      ok: false,
      jobId,
      error: "neighbor_request: target_ref needs blog_id or blog_url",
    };
  }

  const message = resolveNeighborMessage(draftBody, targetRef);
  const budgetMs = neighborMaxMs();
  console.info(
    `[worker] neighbor_request start job=${jobId} url=${pageUrl} maxMs=${budgetMs} msgLen=${message.length}`,
  );

  let page: Page | null = null;
  try {
    console.info(`[worker] neighbor_request step=newPage_begin job=${jobId}`);
    page = await context.newPage();
    return await withTimeout(
      runNeighborOnPage(page, jobId, pageUrl, message, budgetMs),
      budgetMs,
      "execute",
    );
  } catch (err) {
    const messageErr = err instanceof Error ? err.message : String(err);
    console.error(
      `[worker] neighbor_request failed job=${jobId} error=${messageErr}`,
    );
    return { ok: false, jobId, error: messageErr };
  } finally {
    if (page) {
      console.info(`[worker] neighbor_request step=page_close job=${jobId}`);
      await page.close().catch(() => undefined);
    }
  }
}
