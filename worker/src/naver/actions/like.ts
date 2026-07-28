/**
 * Phase 2-3: execute action_jobs.action_type = like via CDP.
 * Classic u_likeit selectors kept; falls back to live DOM discovery + iframe scan.
 */

import type { BrowserContext, Frame, Page } from "playwright";

import {
  failureToErrorColumn,
  makeFailure,
  type ActionFailureDetail,
} from "../../jobs/actionFailure";
import { makeSkip, skipToErrorColumn, type ActionSkipDetail } from "../../jobs/actionOutcome";

export type LikeTargetRef = Record<string, unknown> | null | undefined;

export type LikeExecuteInput = {
  jobId: string;
  targetRef: LikeTargetRef;
};

export type LikeExecuteResult =
  | {
      ok: true;
      jobId: string;
      url: string;
      alreadyLiked: boolean;
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

function failLike(
  jobId: string,
  input: {
    error_code: string;
    error_message: string;
    failed_step: string;
    detail?: Record<string, unknown>;
    steps?: string[];
  },
): Extract<LikeExecuteResult, { ok: false }> {
  const failure = makeFailure(input);
  return {
    ok: false,
    jobId,
    error: failureToErrorColumn(failure),
    failure,
  };
}

function skipLike(
  jobId: string,
  url: string,
  input: {
    outcome?: "skipped" | "not_available";
    reason_code: string;
    reason_message: string;
    failed_step: string;
    detail?: Record<string, unknown>;
    steps?: string[];
  },
): Extract<LikeExecuteResult, { ok: "skipped" }> {
  const skip = makeSkip(input);
  return { ok: "skipped", jobId, url, skip };
}

/** Legacy / known Naver selectors — kept as first probe. */
const LIKE_SELECTORS = [
  "a.u_likeit_button._face",
  "a.u_likeit_list_btn._button._sympathyBtn",
  "a.u_likeit_list_btn._sympathyBtn",
  "a.u_likeit_list_btn[data-type='like']",
  "a.u_likeit_list_btn",
  "button.u_likeit_list_btn",
  "a._sympathyBtn",
];

type LikeProbe = {
  state: "on" | "off" | "missing";
  selector: string | null;
  xpath: string | null;
  frameUrl: string | null;
  source: "classic" | "discover";
};

type DiscoverCandidate = {
  score: number;
  tag: string;
  text: string;
  ariaLabel: string;
  title: string;
  className: string;
  href: string;
  dataAttrs: string;
  xpath: string;
  pressed: string | null;
  inferred: "on" | "off" | "unknown";
};

function likeMaxMs(): number {
  return Number(process.env.WORKER_LIKE_MAX_MS ?? 60_000) || 60_000;
}

function navTimeoutMs(budget: number): number {
  const env = Number(process.env.BROWSER_NAV_TIMEOUT_MS ?? 20_000) || 20_000;
  return Math.max(5_000, Math.min(env, budget - 5_000));
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

export function resolveLikePostUrl(targetRef: LikeTargetRef): string | null {
  const ref = targetRef ?? {};
  let blogId = strRef(ref, "blog_id", "blogId", "blogID");
  let logNo = strRef(ref, "log_no", "logNo", "post_id", "postId");
  let postUrl = strRef(ref, "post_url", "url", "permalink");

  if (postUrl) {
    const m =
      postUrl.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/) ||
      postUrl.match(/[?&]blogId=([^&]+).*?[?&]logNo=(\d+)/i);
    if (m) {
      blogId = blogId ?? decodeURIComponent(m[1]!);
      if (m[2]) logNo = logNo ?? m[2];
    }
  }

  if (!postUrl && blogId && logNo) {
    postUrl = `https://m.blog.naver.com/${blogId}/${logNo}`;
  }

  if (!postUrl) return null;
  const normalized = toMBlogUrl(postUrl);
  if (!/blog\.naver\.com\/[^/]+\/\d+/i.test(normalized) && !logNo) {
    const hasLogInUrl = /\/\d+(\?|$)/.test(normalized);
    if (!hasLogInUrl) return null;
  }
  return normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function likeDebug(
  jobId: string,
  fields: Record<string, unknown>,
): void {
  if (process.env.LIKE_DEBUG !== "1") return;
  console.info("[LIKE_DEBUG]", { job_id: jobId, ...fields });
}

/** Detect login wall / session loss on blog page. */
async function probeLoginRequired(page: Page): Promise<boolean> {
  const url = page.url();
  if (/nid\.naver\.com|nidlogin\.login/i.test(url)) return true;
  return page.evaluate(`(() => {
    var href = location.href || '';
    if (/nid\\.naver\\.com|nidlogin\\.login/i.test(href)) return true;
    var body = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ');
    if (/로그인이 필요|로그인\\s*후\\s*이용/.test(body)) return true;
    var loginCta = document.querySelector('a[href*="nidlogin.login"], a.link_login');
    if (loginCta) {
      var t = ((loginCta.innerText || loginCta.textContent || '') + '').trim();
      if (t.indexOf('로그인') >= 0) return true;
    }
    return false;
  })()`) as Promise<boolean>;
}

/** Wait briefly for Naver like/reaction network after click. */
async function waitLikeNetwork(page: Page, timeoutMs = 4_000): Promise<{
  seen: boolean;
  url: string | null;
  status: number | null;
}> {
  try {
    const resp = await page.waitForResponse(
      (r) => {
        const u = r.url();
        return /like|reaction|sympathy|likeit|blogserver\/like/i.test(u);
      },
      { timeout: timeoutMs },
    );
    return { seen: true, url: resp.url().slice(0, 200), status: resp.status() };
  } catch {
    return { seen: false, url: null, status: null };
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`like timeout after ${ms}ms at ${label}`));
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

/** Classic selector probe (unchanged strategy). */
async function readLikeStateClassic(
  root: Page | Frame,
): Promise<{ state: "on" | "off" | "missing"; selector: string | null }> {
  const selectorsJson = JSON.stringify(LIKE_SELECTORS);
  return root.evaluate(`(() => {
    var sels = ${selectorsJson};
    function visible(el) {
      if (!el) return false;
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (!el || !visible(el)) continue;
      var pressed = el.getAttribute('aria-pressed');
      var className = el.className || '';
      var looksOn = pressed === 'true' || (/\\bon\\b/.test(className) && !/\\boff\\b/.test(className));
      var looksOff = pressed === 'false' || className.indexOf('off') >= 0 || className.indexOf('zeroface') >= 0;
      if (looksOn && !looksOff) return { state: 'on', selector: sels[i] };
      if (looksOff) return { state: 'off', selector: sels[i] };
      return { state: 'off', selector: sels[i] };
    }
    return { state: 'missing', selector: null };
  })()`) as Promise<{
    state: "on" | "off" | "missing";
    selector: string | null;
  }>;
}

/** Live DOM scan for 공감/좋아요 candidates (a/button + data-* + aria). */
const DISCOVER_LIKE_SOURCE = `(() => {
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
  function dataDump(el) {
    var out = [];
    if (!el || !el.attributes) return '';
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a && a.name && a.name.indexOf('data-') === 0) {
        out.push(a.name + '=' + String(a.value || '').slice(0, 40));
      }
    }
    return out.slice(0, 8).join(';');
  }
  function infer(el) {
    var pressed = el.getAttribute('aria-pressed');
    var cls = (el.getAttribute('class') || '').toLowerCase();
    if (pressed === 'true') return 'on';
    if (pressed === 'false') return 'off';
    if (/\\boff\\b|zeroface|empty/.test(cls)) return 'off';
    if (/\\bon\\b|is_on|is-on|liked|active/.test(cls) && !/\\boff\\b/.test(cls)) return 'on';
    return 'unknown';
  }
  function scoreEl(el) {
    var text = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
    var aria = (el.getAttribute('aria-label') || '') + '';
    var title = (el.getAttribute('title') || '') + '';
    var cls = (el.getAttribute('class') || '') + '';
    var href = (el.getAttribute('href') || '') + '';
    var data = dataDump(el);
    var blob = (text + ' ' + aria + ' ' + title + ' ' + cls + ' ' + href + ' ' + data).toLowerCase();
    var score = 0;
    if (/splugin|naver-splugin|share|공유|spic-cid/.test(blob)) score -= 120;
    if (/likes__/.test(cls) && el.tagName.toLowerCase() === 'span') score -= 100;
    if (el.tagName.toLowerCase() === 'span' && el.getAttribute('aria-pressed') == null && !/u_likeit|sympathy|likeit|_face/.test(cls)) score -= 60;
    if (/공감/.test(blob)) score += 50;
    if (/좋아요|like/.test(blob)) score += 40;
    if (/sympath|u_likeit|likeit|reaction|heart/.test(blob)) score += 45;
    if (/data-type=['\"]?like/.test(blob) || /data-type=like/.test(data)) score += 30;
    if (el.getAttribute('aria-pressed') != null) score += 20;
    if (/u_likeit|sympathy|_face|_sympathy/.test(cls)) score += 35;
    var r = el.getBoundingClientRect();
    // Prefer bottom action bar area
    if (r.top > window.innerHeight * 0.55) score += 15;
    if (r.width >= 8 && r.height >= 8) score += 5;
    if (r.width < 4 || r.height < 4) score -= 40;
    return score;
  }

  var nodes = Array.prototype.slice.call(
    document.querySelectorAll('a, button, [role=\"button\"], [aria-pressed], [class*=\"like\"], [class*=\"sympath\"], [class*=\"reaction\"], [class*=\"heart\"]')
  );
  var ranked = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!visible(el)) continue;
    var sc = scoreEl(el);
    if (sc < 25) continue;
    ranked.push({
      score: sc,
      tag: el.tagName.toLowerCase(),
      text: ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 80),
      title: (el.getAttribute('title') || '').slice(0, 80),
      className: (el.getAttribute('class') || '').slice(0, 120),
      href: (el.getAttribute('href') || '').slice(0, 120),
      dataAttrs: dataDump(el).slice(0, 160),
      xpath: xpathOf(el),
      pressed: el.getAttribute('aria-pressed'),
      inferred: infer(el)
    });
  }
  ranked.sort(function (a, b) { return b.score - a.score; });
  return {
    iframeCount: document.querySelectorAll('iframe').length,
    candidates: ranked.slice(0, 12)
  };
})()`;

async function discoverLikeInRoot(
  root: Page | Frame,
): Promise<{ iframeCount: number; candidates: DiscoverCandidate[] }> {
  return (await root.evaluate(DISCOVER_LIKE_SOURCE)) as {
    iframeCount: number;
    candidates: DiscoverCandidate[];
  };
}

async function listRoots(page: Page): Promise<Array<{ label: string; root: Page | Frame; url: string }>> {
  const roots: Array<{ label: string; root: Page | Frame; url: string }> = [
    { label: "main", root: page, url: page.url() },
  ];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const furl = frame.url();
    // Skip empty/about frames
    if (!furl || furl === "about:blank") continue;
    roots.push({ label: `iframe:${furl.slice(0, 80)}`, root: frame, url: furl });
  }
  return roots;
}

async function probeClassicAcrossRoots(
  page: Page,
  jobId: string,
): Promise<LikeProbe> {
  const roots = await listRoots(page);
  console.info(
    `[worker] like step=classic_probe roots=${roots.length} job=${jobId}`,
  );
  for (const { label, root, url } of roots) {
    const classic = await withTimeout(
      readLikeStateClassic(root),
      5_000,
      `classic:${label}`,
    ).catch(() => ({ state: "missing" as const, selector: null }));
    console.info(
      `[worker] like classic job=${jobId} root=${label} state=${classic.state} selector=${classic.selector ?? "none"} url=${url.slice(0, 100)}`,
    );
    if (classic.state !== "missing" && classic.selector) {
      return {
        state: classic.state,
        selector: classic.selector,
        xpath: null,
        frameUrl: label === "main" ? null : url,
        source: "classic",
      };
    }
  }
  return {
    state: "missing",
    selector: null,
    xpath: null,
    frameUrl: null,
    source: "classic",
  };
}

async function probeDiscoverAcrossRoots(
  page: Page,
  jobId: string,
): Promise<LikeProbe> {
  const roots = await listRoots(page);
  let best: DiscoverCandidate | null = null;
  let bestRootUrl: string | null = null;

  for (const { label, root, url } of roots) {
    const discovered = await withTimeout(
      discoverLikeInRoot(root),
      8_000,
      `discover:${label}`,
    ).catch(() => ({ iframeCount: 0, candidates: [] as DiscoverCandidate[] }));

    console.info(
      `[worker] like discover job=${jobId} root=${label} iframesInDoc=${discovered.iframeCount} candidates=${discovered.candidates.length}`,
    );
    for (const c of discovered.candidates.slice(0, 8)) {
      console.info("[worker] like candidate", {
        jobId,
        root: label,
        score: c.score,
        tag: c.tag,
        text: c.text,
        ariaLabel: c.ariaLabel,
        title: c.title,
        className: c.className,
        href: c.href,
        dataAttrs: c.dataAttrs,
        pressed: c.pressed,
        inferred: c.inferred,
        xpath: c.xpath.slice(0, 160),
      });
    }

    const top = discovered.candidates[0];
    if (top && (!best || top.score > best.score)) {
      best = top;
      bestRootUrl = label === "main" ? null : url;
    }
  }

  if (!best || !best.xpath) {
    return {
      state: "missing",
      selector: null,
      xpath: null,
      frameUrl: null,
      source: "discover",
    };
  }

  const cls = (best.className || "").toLowerCase();
  const trustedDiscover =
    best.score >= 70 &&
    !/splugin|likes__/.test(cls) &&
    (best.pressed != null ||
      /u_likeit|sympathy|likeit|_face|_sympathy/.test(cls) ||
      /u_likeit|sympathy|likeit/.test((best.dataAttrs || "").toLowerCase()));
  if (!trustedDiscover) {
    console.info(
      `[worker] like discover rejected job=${jobId} score=${best.score} class=${best.className}`,
    );
    return {
      state: "missing",
      selector: null,
      xpath: null,
      frameUrl: null,
      source: "discover",
    };
  }

  const state: LikeProbe["state"] =
    best.inferred === "on" ? "on" : best.inferred === "off" ? "off" : "off";

  console.info("[worker] like discover picked", {
    jobId,
    score: best.score,
    text: best.text,
    className: best.className,
    href: best.href,
    xpath: best.xpath,
    inferred: best.inferred,
  });

  return {
    state,
    selector: null,
    xpath: best.xpath,
    frameUrl: bestRootUrl,
    source: "discover",
  };
}

function resolveClickRoot(
  page: Page,
  frameUrl: string | null,
): Page | Frame {
  if (!frameUrl) return page;
  const frame = page.frames().find((f) => f.url() === frameUrl);
  return frame ?? page;
}

async function clickProbe(
  page: Page,
  probe: LikeProbe,
  jobId: string,
): Promise<{ ok: boolean; error?: string }> {
  const root = resolveClickRoot(page, probe.frameUrl);
  const clickTarget = probe.selector
    ? root.locator(probe.selector).first()
    : probe.xpath
      ? root.locator(`xpath=${probe.xpath}`).first()
      : null;

  if (!clickTarget) {
    return { ok: false, error: "no click target" };
  }

  const finalSel = probe.selector ?? `xpath=${probe.xpath}`;
  console.info(
    `[worker] like final click selector job=${jobId} source=${probe.source} target=${finalSel} frame=${probe.frameUrl ?? "main"}`,
  );

  await clickTarget.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  try {
    await clickTarget.click({ timeout: 8_000, noWaitAfter: true });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

async function recheckState(page: Page, probe: LikeProbe): Promise<"on" | "off" | "missing"> {
  const root = resolveClickRoot(page, probe.frameUrl);
  if (probe.source === "classic" && probe.selector) {
    const classic = await readLikeStateClassic(root).catch(() => ({
      state: "missing" as const,
      selector: null,
    }));
    return classic.state;
  }
  if (probe.xpath) {
    const inferred = await root
      .evaluate(
        `(() => {
          var r = document.evaluate(${JSON.stringify(probe.xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          var el = r.singleNodeValue;
          if (!el) return 'missing';
          var pressed = el.getAttribute && el.getAttribute('aria-pressed');
          var cls = ((el.getAttribute && el.getAttribute('class')) || '').toLowerCase();
          if (pressed === 'true') return 'on';
          if (pressed === 'false') return 'off';
          if (/\\\\boff\\\\b|zeroface/.test(cls)) return 'off';
          if (/\\\\bon\\\\b|is_on|liked|active/.test(cls) && !/\\\\boff\\\\b/.test(cls)) return 'on';
          return 'unknown';
        })()`,
      )
      .catch(() => "missing");
    if (inferred === "on") return "on";
    if (inferred === "off") return "off";
    if (inferred === "missing") return "missing";
  }
  // Fallback: rediscover
  const again = await probeDiscoverAcrossRoots(page, "recheck");
  return again.state;
}

async function runLikeOnPage(
  page: Page,
  jobId: string,
  url: string,
  budgetMs: number,
): Promise<LikeExecuteResult> {
  const steps: string[] = ["visit_start"];
  const navMs = navTimeoutMs(budgetMs);
  page.setDefaultTimeout(Math.min(10_000, navMs));
  page.setDefaultNavigationTimeout(navMs);

  likeDebug(jobId, { target_url: url, phase: "start" });
  console.info(`[worker] like step=newPage_ok job=${jobId}`);
  console.info(
    `[worker] like step=goto_begin job=${jobId} timeoutMs=${navMs} waitUntil=domcontentloaded`,
  );

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: navMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[worker] like step=goto_failed job=${jobId} error=${message}`,
    );
    steps.push("goto");
    likeDebug(jobId, {
      target_url: url,
      page_url_after_goto: page.url(),
      click_result: "goto_failed",
      verify_result: "n/a",
      error: message,
    });
    return failLike(jobId, {
      error_code: "GOTO_FAILED",
      error_message: `페이지 이동 실패: ${message}`,
      failed_step: "goto",
      steps,
      detail: { url },
    });
  }

  steps.push("goto", "post_loaded");
  console.info(`[worker] like step=goto_done job=${jobId} url=${page.url()}`);

  // Allow late widgets / iframes to mount
  await sleep(1_200);
  let title = "";
  try {
    title = await withTimeout(page.title(), 5_000, "page.title");
  } catch {
    title = "(title timeout)";
  }
  console.info(
    `[worker] post loaded job=${jobId} url=${page.url()} title=${title}`,
  );

  const loginRequired = await probeLoginRequired(page).catch(() => false);
  likeDebug(jobId, {
    target_url: url,
    page_url_after_goto: page.url(),
    title,
    login_status: loginRequired ? "required" : "ok",
  });
  if (loginRequired) {
    return failLike(jobId, {
      error_code: "LOGIN_REQUIRED",
      error_message: "네이버 로그인이 필요합니다",
      failed_step: "post_loaded",
      steps,
      detail: { url, current_url: page.url(), page_title: title },
    });
  }

  console.info(
    `[worker] like step=frames job=${jobId} count=${page.frames().length}`,
  );
  for (const f of page.frames()) {
    console.info(`[worker] like frame url=${f.url().slice(0, 120)}`);
  }

  steps.push("like_button_search");
  let probe = await probeClassicAcrossRoots(page, jobId);
  if (probe.state === "missing") {
    for (let i = 0; i < 4; i++) {
      await sleep(500);
      probe = await probeClassicAcrossRoots(page, jobId);
      if (probe.state !== "missing") break;
    }
  }

  if (probe.state === "missing") {
    console.info(`[worker] like step=discover_fallback job=${jobId}`);
    probe = await probeDiscoverAcrossRoots(page, jobId);
  }

  likeDebug(jobId, {
    like_button_found: probe.state !== "missing",
    like_button_selector: probe.selector ?? probe.xpath,
    before_like_state: probe.state,
    source: probe.source,
    frame: probe.frameUrl ?? "main",
  });

  if (probe.state === "missing") {
    console.info(
      `[worker] like skipped job=${jobId} reason=LIKE_BUTTON_NOT_AVAILABLE`,
    );
    likeDebug(jobId, {
      like_button_found: false,
      verify_result: "skipped_no_button",
    });
    return skipLike(jobId, page.url() || url, {
      outcome: "not_available",
      reason_code: "LIKE_BUTTON_NOT_AVAILABLE",
      reason_message: "공감 버튼이 없는 글입니다.",
      failed_step: "button_search",
      steps,
      detail: {
        url,
        current_url: page.url(),
        page_title: title,
        failure_reason: {
          code: "LIKE_BUTTON_NOT_AVAILABLE",
          message: "공감 버튼이 없는 글입니다.",
        },
      },
    });
  }

  if (probe.state === "on") {
    console.info(`[worker] like already liked job=${jobId}`);
    console.info(`[worker] like completed job=${jobId}`);
    likeDebug(jobId, {
      before_like_state: "on",
      after_like_state: "on",
      click_result: "skipped_already_liked",
      verify_result: "already_on",
    });
    return { ok: true, jobId, url: page.url(), alreadyLiked: true };
  }

  console.info(
    `[worker] like step=click_begin job=${jobId} source=${probe.source}`,
  );
  steps.push("like_click");
  const networkWait = waitLikeNetwork(page, 5_000);
  const clicked = await clickProbe(page, probe, jobId);
  if (!clicked.ok) {
    void networkWait.catch(() => undefined);
    console.error(
      `[worker] like step=click_failed job=${jobId} error=${clicked.error}`,
    );
    likeDebug(jobId, {
      click_result: `failed:${clicked.error}`,
      verify_result: "n/a",
    });
    return failLike(jobId, {
      error_code: "LIKE_CLICK_FAILED",
      error_message: `공감 클릭 실패: ${clicked.error}`,
      failed_step: "like_click",
      steps,
      detail: { url, current_url: page.url(), selector: probe.selector },
    });
  }
  const network = await networkWait;
  likeDebug(jobId, {
    click_result: "ok",
    like_network_seen: network.seen,
    like_network_url: network.url,
    like_network_status: network.status,
  });
  console.info(`[worker] like clicked job=${jobId}`);
  await sleep(1_000);

  steps.push("verify");
  let after = await recheckState(page, probe);
  console.info(`[worker] like step=verify1 job=${jobId} state=${after}`);
  likeDebug(jobId, { after_like_state: after, verify_pass: 1 });
  if (after !== "on") {
    console.info(`[worker] like step=click_retry job=${jobId}`);
    const networkWait2 = waitLikeNetwork(page, 4_000);
    await clickProbe(page, probe, jobId);
    await networkWait2;
    await sleep(1_000);
    after = await recheckState(page, probe);
    console.info(`[worker] like step=verify2 job=${jobId} state=${after}`);
    likeDebug(jobId, { after_like_state: after, verify_pass: 2 });
  }

  if (after !== "on") {
    console.error(`[worker] like failed job=${jobId} reason=verify`);
    likeDebug(jobId, {
      after_like_state: after,
      verify_result: "failed",
      like_network_seen: network.seen,
    });
    return failLike(jobId, {
      error_code: "LIKE_VERIFY_FAILED",
      error_message: "공감 클릭 후 상태가 반영되지 않았습니다",
      failed_step: "verify",
      steps,
      detail: {
        url,
        current_url: page.url(),
        state_after: after,
        like_network_seen: network.seen,
        like_network_url: network.url,
      },
    });
  }

  console.info(`[worker] like completed job=${jobId}`);
  likeDebug(jobId, {
    after_like_state: "on",
    click_result: "ok",
    verify_result: "ok",
    like_network_seen: network.seen,
  });
  return { ok: true, jobId, url: page.url(), alreadyLiked: false };
}

export async function executeLike(
  context: BrowserContext,
  input: LikeExecuteInput,
): Promise<LikeExecuteResult> {
  const { jobId, targetRef } = input;
  const url = resolveLikePostUrl(targetRef);
  if (!url) {
    console.error(`[worker] like skip job=${jobId} reason=missing_post_url`);
    return failLike(jobId, {
      error_code: "MISSING_POST_URL",
      error_message:
        "target_ref에 post_url/url 또는 blog_id+log_no가 필요합니다",
      failed_step: "visit_start",
    });
  }

  const budgetMs = likeMaxMs();
  console.info(
    `[worker] like start job=${jobId} url=${url} maxMs=${budgetMs}`,
  );

  const pageRef: { current: Page | null } = { current: null };
  const work = (async (): Promise<LikeExecuteResult> => {
    console.info(`[worker] like step=newPage_begin job=${jobId}`);
    const p = await withTimeout(context.newPage(), 15_000, "context.newPage");
    pageRef.current = p;
    return runLikeOnPage(p, jobId, url, budgetMs);
  })();

  try {
    return await withTimeout(work, budgetMs, "executeLike_total");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] like failed job=${jobId} error=${message}`);
    const isTimeout = /timeout/i.test(message);
    return failLike(jobId, {
      error_code: isTimeout ? "TIMEOUT" : "UNKNOWN",
      error_message: message,
      failed_step: isTimeout ? "verify" : "unknown",
      detail: { url },
    });
  } finally {
    const toClose = pageRef.current;
    if (toClose) {
      console.info(`[worker] like step=page_close job=${jobId}`);
      await withTimeout(toClose.close(), 5_000, "page.close").catch(
        () => undefined,
      );
    }
  }
}
