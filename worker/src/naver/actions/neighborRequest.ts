/**
 * CDP Worker neighbor_request executor.
 * Mirrors NaverBlogAdapter.requestNeighbor; classic selectors + discover fallback.
 * Does not modify visit/like/comment executors.
 */

import type { BrowserContext, Page } from "playwright";

import {
  failureToErrorColumn,
  makeFailure,
  type ActionFailureDetail,
} from "../../jobs/actionFailure";
import {
  makeSkip,
  skipToErrorColumn,
  type ActionSkipDetail,
} from "../../jobs/actionOutcome";

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
  | {
      ok: false;
      jobId: string;
      error: string;
      failure: ActionFailureDetail;
    }
  | {
      ok: "skipped";
      jobId: string;
      url: string;
      skip: ActionSkipDetail;
    };

function failNeighbor(
  jobId: string,
  input: {
    error_code: string;
    error_message: string;
    failed_step: string;
    detail?: Record<string, unknown>;
    steps?: string[];
  },
): Extract<NeighborExecuteResult, { ok: false }> {
  const failure = makeFailure(input);
  return {
    ok: false,
    jobId,
    error: failureToErrorColumn(failure),
    failure,
  };
}

function skipNeighbor(
  jobId: string,
  url: string,
  input: {
    reason_code: string;
    reason_message: string;
    failed_step: string;
    detail?: Record<string, unknown>;
    steps?: string[];
  },
): Extract<NeighborExecuteResult, { ok: "skipped" }> {
  return {
    ok: "skipped",
    jobId,
    url,
    skip: makeSkip({ outcome: "excluded", ...input }),
  };
}

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
  'label:has-text("서로이웃을 신청")',
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
  if (blogId) return `https://m.blog.naver.com/${blogId}`;

  const blogUrl = strRef(ref, "blog_url", "profile_url");
  if (blogUrl) {
    const id = extractBlogIdFromUrl(blogUrl);
    if (id) return `https://m.blog.naver.com/${id}`;
    return toMBlogUrl(blogUrl);
  }

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

type BuddyAddKind = "mutual" | "one_way_only" | "none";

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
    var neighborOnlyBtn = false;
    var allBtns = document.querySelectorAll('button, a');
    for (var n = 0; n < allBtns.length; n++) {
      var btn = allBtns[n];
      if (!visible(btn)) continue;
      var bt = ((btn.innerText || btn.textContent || '') + '').replace(/\\s+/g, '').trim();
      if (bt === '이웃') { neighborOnlyBtn = true; break; }
    }
    if (neighborOnlyBtn && !hasAddBuddy) return 'accepted';
    if (/\\d+명의\\s*이웃/.test(bodyText) && bodyText.indexOf('이웃추가') < 0 && bodyText.indexOf('서로이웃추가') < 0) {
      return 'accepted';
    }
    if (/서로이웃|이웃입니다|이미\\s*이웃/.test(bodyText) && !hasAddBuddy) {
      return 'accepted';
    }
    if (!hasAddBuddy && !hasCancelRequest && /이웃\\s*\\d+/.test(bodyText)) {
      if (/이웃삭제|서로이웃\\s*끊|이웃\\s*취소|이웃관리/.test(bodyText)) {
        return 'accepted';
      }
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

async function gotoBuddyAddForm(
  page: Page,
  blogId: string,
  budgetMs: number,
): Promise<boolean> {
  const formUrl = `https://m.blog.naver.com/BuddyAddForm.naver?blogId=${encodeURIComponent(
    blogId,
  )}`;
  const navMs = navTimeoutMs(budgetMs);
  try {
    await withTimeout(
      page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: navMs }),
      navMs + 2_000,
      "buddy_form_goto",
    );
    await sleep(900);
    return /BuddyAddForm|buddyadd/i.test(page.url());
  } catch (err) {
    console.warn(
      `[worker] neighbor_request buddy_form_goto_failed blogId=${blogId} ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

async function openBuddyForm(
  page: Page,
  blogId: string | null,
  budgetMs: number,
): Promise<"classic" | "discover" | "direct" | null> {
  if (blogId) {
    const ok = await gotoBuddyAddForm(page, blogId, budgetMs);
    if (ok) {
      console.info(
        `[worker] neighbor_request open direct BuddyAddForm blogId=${blogId}`,
      );
      return "direct";
    }
  }

  console.info("[worker] neighbor_request step=open_classic");
  const classic = await clickFirstLocator(page, OPEN_BUDDY_SELECTORS);
  if (classic) {
    console.info(`[worker] neighbor_request open classic=${classic}`);
    await page
      .waitForURL(/BuddyAddForm|buddyadd/i, { timeout: 12_000 })
      .catch(() => undefined);
    await sleep(900);
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
    await page
      .waitForURL(/BuddyAddForm|buddyadd/i, { timeout: 12_000 })
      .catch(() => undefined);
    await sleep(900);
    return "discover";
  }

  if (found.xpath) {
    const byX = page.locator(`xpath=${found.xpath}`).first();
    if ((await byX.count().catch(() => 0)) > 0) {
      await byX.click({ timeout: 5_000 });
      console.info(
        `[worker] neighbor_request open discover xpath text=${found.text}`,
      );
      await page
        .waitForURL(/BuddyAddForm|buddyadd/i, { timeout: 12_000 })
        .catch(() => undefined);
      await sleep(900);
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

/**
 * Pure verify interpreter — success only when relation clearly changed
 * to pending_request / accepted (or explicit success copy).
 */
export function interpretNeighborVerify(input: {
  relation: RelationProbe;
  bodyText: string;
}): { ok: true; detail: string } | { ok: false; detail: string; error_code: string } {
  const { relation, bodyText } = input;
  if (relation === "pending_request" || relation === "accepted") {
    return { ok: true, detail: `relation=${relation}` };
  }
  if (/신청\s*(이\s*)?완료|신청했습니다|전송했습니다|접수/.test(bodyText)) {
    return { ok: true, detail: "success_copy" };
  }
  if (/이미\s*(서로)?이웃|이웃입니다/.test(bodyText)) {
    return { ok: true, detail: "already_neighbor_copy" };
  }
  if (/로그인|본인인증|차단|하루\s*제한|신청\s*불가|오류/.test(bodyText)) {
    return {
      ok: false,
      detail: "blocked_or_error_ui",
      error_code: "REQUEST_NOT_AVAILABLE",
    };
  }
  if (/서로이웃\s*(신청\s*)?불가|서로이웃이\s*불가|이웃만\s*가능/.test(bodyText)) {
    return {
      ok: false,
      detail: "mutual_not_available_copy",
      error_code: "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
    };
  }
  return {
    ok: false,
    detail: `relation_unchanged=${relation}`,
    error_code: "VERIFY_FAILED",
  };
}

async function verifyAfterSubmit(page: Page): Promise<{
  ok: boolean;
  detail: string;
  error_code?: string;
}> {
  await sleep(1_200);
  const relation = await probeRelation(page);
  const bodyText = (
    (await page.locator("body").innerText().catch(() => "")) || ""
  )
    .replace(/\s+/g, " ")
    .trim();
  return interpretNeighborVerify({ relation, bodyText });
}

async function runNeighborOnPage(
  page: Page,
  jobId: string,
  pageUrl: string,
  message: string,
  budgetMs: number,
): Promise<NeighborExecuteResult> {
  const steps: string[] = ["page_loaded"];
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
    steps.push("goto");
    return failNeighbor(jobId, {
      error_code: "GOTO_FAILED",
      error_message: `페이지 이동 실패: ${messageErr}`,
      failed_step: "goto",
      steps,
      detail: { url: pageUrl },
    });
  }

  steps.push("page_loaded");
  console.info(
    `[worker] neighbor_request step=goto_done job=${jobId} url=${page.url()}`,
  );
  await sleep(1_200);

  steps.push("relation_detect");
  const before = await probeRelation(page);
  console.info(
    `[worker] neighbor_request relation_before=${before} job=${jobId}`,
  );
  const blogId = extractBlogIdFromUrl(pageUrl) ?? extractBlogIdFromUrl(page.url());

  if (before === "accepted") {
    console.info(
      `[worker] neighbor_request already_neighbor job=${jobId} → excluded`,
    );
    return skipNeighbor(jobId, pageUrl, {
      reason_code: "ALREADY_NEIGHBOR",
      reason_message: "이미 이웃인 블로그입니다.",
      failed_step: "relation_detect",
      steps,
      detail: { url: pageUrl, relation: before },
    });
  }

  if (before === "pending_request") {
    console.info(
      `[worker] neighbor_request already_pending job=${jobId} → excluded`,
    );
    return skipNeighbor(jobId, pageUrl, {
      reason_code: "ALREADY_PENDING",
      reason_message: "이미 서로이웃 신청 중인 블로그입니다",
      failed_step: "relation_detect",
      steps,
      detail: { url: pageUrl, relation: before },
    });
  }

  steps.push("button_search");
  const buddyKind = await probeBuddyAddKind(page);
  console.info(
    `[worker] neighbor_request buddy_add_kind=${buddyKind} job=${jobId}`,
  );

  let formAlreadyOpen = false;
  if (buddyKind === "one_way_only") {
    const openedProbe = await openBuddyForm(page, blogId, budgetMs);
    steps.push("open_buddy_probe");
    if (!openedProbe) {
      return skipNeighbor(jobId, pageUrl, {
        reason_code: "NEIGHBOR_BUTTON_NOT_AVAILABLE",
        reason_message: "서로이웃 신청 버튼 없음",
        failed_step: "button_search",
        steps,
        detail: { url: pageUrl, current_url: page.url(), buddy_add_kind: buddyKind },
      });
    }
    formAlreadyOpen = true;
    const mutualInForm = await probeMutualOptionInForm(page);
    console.info(
      `[worker] neighbor_request mutual_in_form=${mutualInForm} job=${jobId}`,
    );
    if (!mutualInForm) {
      return skipNeighbor(jobId, pageUrl, {
        reason_code: "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
        reason_message: "서로이웃이 불가한 블로그입니다.",
        failed_step: "button_search",
        steps,
        detail: {
          url: pageUrl,
          current_url: page.url(),
          buddy_add_kind: buddyKind,
          failure_reason: {
            code: "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
            message: "서로이웃이 불가한 블로그입니다.",
          },
        },
      });
    }
  }
  if (buddyKind === "none") {
    const again = await probeRelation(page);
    if (again === "accepted") {
      return skipNeighbor(jobId, pageUrl, {
        reason_code: "ALREADY_NEIGHBOR",
        reason_message: "이미 이웃인 블로그입니다.",
        failed_step: "button_search",
        steps,
        detail: { url: pageUrl, relation: again },
      });
    }
    if (again === "pending_request") {
      return skipNeighbor(jobId, pageUrl, {
        reason_code: "ALREADY_PENDING",
        reason_message: "이미 서로이웃 신청 중인 블로그입니다.",
        failed_step: "button_search",
        steps,
        detail: { url: pageUrl, relation: again },
      });
    }
    console.info(
      `[worker] neighbor_request excluded job=${jobId} reason=NEIGHBOR_BUTTON_NOT_AVAILABLE`,
    );
    let pageTitle = "";
    try {
      pageTitle = await page.title();
    } catch {
      pageTitle = "";
    }
    return skipNeighbor(jobId, pageUrl, {
      reason_code: "NEIGHBOR_BUTTON_NOT_AVAILABLE",
      reason_message: "서로이웃 신청 버튼 없음",
      failed_step: "button_search",
      steps,
      detail: {
        url: pageUrl,
        current_url: page.url(),
        page_title: pageTitle,
        relation_before: before,
        relation_after_probe: again,
      },
    });
  }

  const opened = formAlreadyOpen
    ? "direct"
    : await openBuddyForm(page, blogId, budgetMs);
  steps.push(
    opened === "classic" || opened === "direct"
      ? "button_click"
      : opened === "discover"
        ? "button_click"
        : "button_search",
  );
  if (!opened) {
    return skipNeighbor(jobId, pageUrl, {
      reason_code: "NEIGHBOR_BUTTON_NOT_AVAILABLE",
      reason_message: "서로이웃 신청 버튼 없음",
      failed_step: "button_search",
      steps,
      detail: { url: pageUrl, current_url: page.url() },
    });
  }

  steps.push("modal_open");
  console.info(`[worker] neighbor_request step=submit_begin job=${jobId}`);
  steps.push("option_select", "fill_message");
  const confirmed = await fillAndConfirm(page, message);
  steps.push("confirm_click");
  if (!confirmed) {
    console.error(
      `[worker] neighbor_request failed job=${jobId} reason=confirm_not_found`,
    );
    return failNeighbor(jobId, {
      error_code: "NEIGHBOR_CONFIRM_NOT_FOUND",
      error_message: "서로이웃 신청 확인 버튼을 찾지 못했습니다",
      failed_step: "confirm_click",
      steps,
      detail: { url: pageUrl, current_url: page.url() },
    });
  }
  console.info(`[worker] neighbor_request step=submit_clicked job=${jobId}`);
  steps.push("confirm_click");

  const verified = await verifyAfterSubmit(page);
  steps.push("verify");
  console.info(
    `[worker] neighbor_request verify job=${jobId} ok=${verified.ok} detail=${verified.detail}`,
  );
  if (!verified.ok) {
    const code = verified.error_code ?? "VERIFY_FAILED";
    const bodyAfter = (
      (await page.locator("body").innerText().catch(() => "")) || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const stuckOnForm = /BuddyAddForm|buddyadd/i.test(page.url());
    const mutualBlocked =
      code === "NEIGHBOR_MUTUAL_NOT_AVAILABLE" ||
      /서로이웃\s*(신청\s*)?불가|서로이웃이\s*불가|이웃만\s*가능/.test(
        bodyAfter,
      );
    if (mutualBlocked || (stuckOnForm && code === "VERIFY_FAILED")) {
      return skipNeighbor(jobId, pageUrl, {
        reason_code: "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
        reason_message: "서로이웃이 불가한 블로그입니다.",
        failed_step: "verify",
        steps,
        detail: {
          url: pageUrl,
          current_url: page.url(),
          verify_detail: verified.detail,
          failure_reason: {
            code: "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
            message: "서로이웃이 불가한 블로그입니다.",
          },
        },
      });
    }
    if (code === "REQUEST_NOT_AVAILABLE") {
      return skipNeighbor(jobId, pageUrl, {
        reason_code: "REQUEST_NOT_AVAILABLE",
        reason_message: "서로이웃 신청이 불가능한 상태입니다",
        failed_step: "verify",
        steps,
        detail: {
          url: pageUrl,
          current_url: page.url(),
          verify_detail: verified.detail,
        },
      });
    }
    if (code === "NEIGHBOR_MUTUAL_NOT_AVAILABLE") {
      return skipNeighbor(jobId, pageUrl, {
        reason_code: "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
        reason_message: "서로이웃이 불가한 블로그입니다.",
        failed_step: "verify",
        steps,
        detail: {
          url: pageUrl,
          current_url: page.url(),
          verify_detail: verified.detail,
          failure_reason: {
            code: "NEIGHBOR_MUTUAL_NOT_AVAILABLE",
            message: "서로이웃이 불가한 블로그입니다.",
          },
        },
      });
    }
    return failNeighbor(jobId, {
      error_code: code,
      error_message: `서로이웃 신청 검증 실패: ${verified.detail}`,
      failed_step: "verify",
      steps,
      detail: {
        url: pageUrl,
        current_url: page.url(),
        verify_detail: verified.detail,
      },
    });
  }

  if (verified.detail === "already_neighbor_copy") {
    return skipNeighbor(jobId, pageUrl, {
      reason_code: "ALREADY_NEIGHBOR",
      reason_message: "이미 이웃인 블로그입니다.",
      failed_step: "verify",
      steps,
      detail: { url: pageUrl, verify_detail: verified.detail },
    });
  }

  console.info(
    `[worker] neighbor_request completed job=${jobId} detail=${verified.detail}`,
  );
  return {
    ok: true,
    jobId,
    url: pageUrl,
    alreadyNeighbor:
      verified.detail.includes("accepted") ||
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
    return failNeighbor(jobId, {
      error_code: "MISSING_BLOG_URL",
      error_message: "target_ref에 blog_id 또는 blog_url이 없습니다",
      failed_step: "visit_start",
      detail: {},
    });
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
    const isTimeout = /timeout/i.test(messageErr);
    return failNeighbor(jobId, {
      error_code: isTimeout ? "TIMEOUT" : "UNKNOWN",
      error_message: messageErr,
      failed_step: isTimeout ? "verify" : "unknown",
      detail: { url: pageUrl },
    });
  } finally {
    if (page) {
      console.info(`[worker] neighbor_request step=page_close job=${jobId}`);
      await page.close().catch(() => undefined);
    }
  }
}
