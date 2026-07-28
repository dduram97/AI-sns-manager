/**
 * Comment execution helpers for NaverBlogAdapter (mirrors worker comment.ts).
 */
import type { Page } from "playwright";

import { sleep } from "./timing";

export const COMMENT_INPUT_SELECTORS = [
  "#naverComment__write_textarea",
  "#naverCommentwrite_textarea",
  'div.u_cbox_text[contenteditable="true"]',
  '[contenteditable="true"].u_cbox_text',
  "div.u_cbox_write_area [contenteditable='true']",
  "textarea.u_cbox_text",
  ".u_cbox_text",
  "textarea[placeholder*='댓글']",
];

export const COMMENT_SUBMIT_SELECTORS = [
  "button.u_cbox_btn_upload",
  ".u_cbox_btn_upload",
  'button:has-text("등록")',
  'a:has-text("등록")',
];

export function commentDebug(
  jobId: string,
  fields: Record<string, unknown>,
): void {
  if (process.env.COMMENT_DEBUG !== "1") return;
  console.info("[COMMENT_DEBUG]", { job_id: jobId, ...fields });
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

function toMBlogPostUrl(postUrl: string): string {
  try {
    const u = new URL(postUrl.trim());
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
  return postUrl
    .replace(/^https?:\/\/blog\.naver\.com\//i, "https://m.blog.naver.com/")
    .replace(
      /^https?:\/\/m\.blog\.naver\.com\//i,
      "https://m.blog.naver.com/",
    );
}

export function resolveCommentPageUrl(input: {
  postUrl: string;
  blogId?: string | null;
  logNo?: string | null;
  targetRef?: Record<string, unknown>;
}): string {
  const ref = input.targetRef ?? {};
  let blogId = input.blogId ?? strRef(ref, "blog_id", "blogId", "blogID");
  let logNo = input.logNo ?? strRef(ref, "log_no", "logNo", "post_id", "postId");
  const postUrl = toMBlogPostUrl(input.postUrl);

  const m =
    postUrl.match(/blog\.naver\.com\/([^/?#]+)\/(\d+)/i) ||
    postUrl.match(/[?&]blogId=([^&]+).*?[?&]logNo=(\d+)/i);
  if (m) {
    blogId = blogId ?? decodeURIComponent(m[1]!);
    logNo = logNo ?? m[2]!;
  }

  if (blogId && logNo) {
    return `https://m.blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}&modal=comment`;
  }
  if (postUrl.includes("modal=")) return postUrl;
  const joiner = postUrl.includes("?") ? "&" : "?";
  return `${postUrl}${joiner}modal=comment`;
}

async function findCommentInputSelector(page: Page): Promise<string | null> {
  for (const sel of COMMENT_INPUT_SELECTORS) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) return sel;
  }
  return null;
}

export async function ensureCommentComposerOpen(page: Page): Promise<void> {
  if (await findCommentInputSelector(page)) return;

  const openers = [
    'a:has-text("댓글")',
    'button:has-text("댓글")',
    '[class*="comment"]',
    ".u_cbox_btn_write",
    'a[href*="modal=comment"]',
  ];
  for (const sel of openers) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) <= 0) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ timeout: 3_000, force: true }).catch(() => undefined);
    await sleep(800);
    if (await findCommentInputSelector(page)) return;
  }

  const u = page.url();
  if (!/[?&]modal=comment/i.test(u)) {
    const next = u.includes("?") ? `${u}&modal=comment` : `${u}?modal=comment`;
    await page
      .goto(next, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => undefined);
    await sleep(1_200);
  }
}

export async function waitForCommentInput(
  page: Page,
  timeoutMs = 12_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await ensureCommentComposerOpen(page);
    const sel = await findCommentInputSelector(page);
    if (sel) return sel;
    await sleep(400);
  }
  return null;
}

export type CommentFillResult = {
  ok: boolean;
  selector: string | null;
  typedLength: number;
  error?: string;
};

export async function verifyCommentSubmitted(
  page: Page,
  body: string,
): Promise<{ ok: boolean; detail: string }> {
  const snippet = body.slice(0, 24);
  const found = await page
    .locator(`text=${snippet}`)
    .first()
    .waitFor({ state: "visible", timeout: 6_000 })
    .then(() => true)
    .catch(() => false);
  if (found) return { ok: true, detail: "comment_text_visible" };

  const listHit = await page.evaluate(`(() => {
    var snip = ${JSON.stringify(snippet)};
    var nodes = document.querySelectorAll('.u_cbox_contents, .u_cbox_text_wrap, .u_cbox_list, [class*="cbox"]');
    for (var i = 0; i < nodes.length; i++) {
      var t = ((nodes[i].innerText || nodes[i].textContent || '') + '');
      if (t.indexOf(snip) >= 0) return true;
    }
    return false;
  })()`);
  if (listHit) return { ok: true, detail: "comment_in_list_dom" };

  const busy = await page
    .locator(
      "button.u_cbox_btn_upload[disabled], .u_cbox_btn_upload.u_cbox_btn_upload_off",
    )
    .count()
    .catch(() => 0);
  if (busy > 0) return { ok: false, detail: "submit_busy_no_echo" };

  return { ok: false, detail: "comment_not_found_after_submit" };
}

export async function clickCommentSubmit(
  page: Page,
): Promise<{ ok: boolean; selector: string | null }> {
  for (const sel of COMMENT_SUBMIT_SELECTORS) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    try {
      await loc.click({ timeout: 8_000, noWaitAfter: true, force: true });
      return { ok: true, selector: sel };
    } catch {
      // try next
    }
  }

  const clicked = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("button, a, [role='button']"),
    );
    for (const el of nodes) {
      const text = ((el as HTMLElement).innerText || "")
        .replace(/\s+/g, " ")
        .trim();
      const cls = (el.getAttribute("class") || "").toLowerCase();
      if (text === "등록" || cls.includes("u_cbox_btn_upload")) {
        (el as HTMLElement).click();
        return text || cls.slice(0, 40);
      }
    }
    return null;
  });
  if (clicked) {
    return { ok: true, selector: `discover:${clicked}` };
  }
  return { ok: false, selector: null };
}

export async function probeLoginRequired(page: Page): Promise<boolean> {
  const url = page.url();
  if (/nid\.naver\.com|nidlogin\.login/i.test(url)) return true;
  return Boolean(
    await page
      .evaluate(`(() => {
      var href = location.href || '';
      if (/nid\\.naver\\.com|nidlogin\\.login/i.test(href)) return true;
      var body = (document.body && document.body.innerText) || '';
      if (/로그인|login/i.test(body.slice(0, 500)) && /nid/i.test(href)) return true;
      return false;
    })()`)
      .catch(() => false),
  );
}
