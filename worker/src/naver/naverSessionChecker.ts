/**
 * Phase 2-1: verify Naver login on the CDP-attached Chrome session.
 * Reuses connectOverCdp from browser/cdpClient (no action_jobs changes).
 */

import type { BrowserContext, Page } from "playwright";

import {
  connectOverCdp,
  disconnectCdp,
  resolveCdpUrl,
  type CdpConnection,
} from "../browser/cdpClient";

const NAVER_HOME = "https://www.naver.com/";

export type NaverSessionCheckResult = {
  ok: boolean;
  loggedIn: boolean;
  url: string;
  title: string;
  signals: {
    visibleLoginCta: boolean;
    hasLoginForm: boolean;
    logout: boolean;
    myName: boolean;
    myNameText: string;
    mailOrNoti: boolean;
    authCookies: boolean;
    authCookieNames: string[];
  };
  error?: string;
};

/** Mirror app login.ts DOM probe (www.naver.com). */
const DETECT_DOM_SOURCE = `(() => {
  function textOf(el) {
    return ((el && el.textContent) ? el.textContent : '').replace(/\\s+/g, ' ').trim();
  }
  function isVisible(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  var loginCtas = document.querySelectorAll(
    'a.MyView-module__link_login___HpHMW, a.link_login, a[href*="nidlogin.login"]'
  );
  var visibleLoginCta = false;
  for (var i = 0; i < loginCtas.length; i++) {
    if (isVisible(loginCtas[i]) && textOf(loginCtas[i]).indexOf('로그인') >= 0) {
      visibleLoginCta = true;
      break;
    }
  }

  var hasLoginForm = !!(document.querySelector('#id, #pw, .login_form'));

  var logout = document.querySelector(
    'a[href*="nidlogin.logout"], a[href*="nid.naver.com/nidlogin.logout"]'
  );
  var myName = document.querySelector(
    '#account .MyView-module__my_text___xTjFB, #account .MyView-module__nickname, .sc_login .user_name, .user_info .name, [class*="MyView-module__my_name"], [class*="MyView-module__nickname"]'
  );
  var mailOrNoti = document.querySelector(
    'a[href*="mail.naver.com"], a[href*="note.naver.com"], button[class*="button_mail"], a[class*="link_mail"]'
  );

  var positive = !!(logout || myName || mailOrNoti);
  var loggedOut = visibleLoginCta || hasLoginForm;
  var loggedIn = positive && !loggedOut;

  return {
    loggedIn: loggedIn,
    signals: {
      visibleLoginCta: visibleLoginCta,
      hasLoginForm: hasLoginForm,
      logout: !!logout,
      myName: !!myName,
      myNameText: textOf(myName).slice(0, 40),
      mailOrNoti: !!mailOrNoti,
      positive: positive,
      loggedOut: loggedOut
    }
  };
})()`;

async function hasNaverAuthCookies(page: Page): Promise<{
  ok: boolean;
  names: string[];
}> {
  const cookies = await page.context().cookies([
    "https://www.naver.com/",
    "https://nid.naver.com/",
    "https://m.blog.naver.com/",
  ]);
  const names = cookies.map((c) => c.name);
  return {
    ok: names.includes("NID_AUT") && names.includes("NID_SES"),
    names: names.filter((n) => n.startsWith("NID_") || n === "nid_inf"),
  };
}

export function classifyCdpConnectError(err: unknown): {
  code: "chrome_not_running" | "cdp_connect_failed";
  message: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes("econnrefused") ||
    lower.includes("connect econnrefused") ||
    lower.includes("browser has been closed") ||
    lower.includes("target page, context or browser has been closed") ||
    lower.includes("ns_error_connection_refused") ||
    (lower.includes("timeout") && lower.includes("connect"))
  ) {
    return {
      code: "chrome_not_running",
      message:
        "Chrome이 실행되지 않았거나 CDP 포트에 연결할 수 없습니다. ./scripts/start-cdp-chrome.sh 후 http://127.0.0.1:9222/json/version 을 확인하세요.",
    };
  }
  if (raw.includes("contexts() is empty")) {
    return {
      code: "cdp_connect_failed",
      message:
        "CDP는 붙었지만 browser context가 비어 있습니다. remote-debugging Chrome 창이 열려 있는지 확인하세요.",
    };
  }
  return {
    code: "cdp_connect_failed",
    message: `CDP 연결 실패: ${raw}`,
  };
}

async function probeOnPage(page: Page): Promise<NaverSessionCheckResult> {
  console.info(`[cdp-worker:naver] goto ${NAVER_HOME}`);
  await page.goto(NAVER_HOME, {
    waitUntil: "domcontentloaded",
    timeout: Number(process.env.BROWSER_NAV_TIMEOUT_MS ?? 45_000) || 45_000,
  });

  const url = page.url();
  const title = await page.title();
  console.info(`[cdp-worker:naver] url=${url}`);
  console.info(`[cdp-worker:naver] title=${title}`);

  const cookies = await hasNaverAuthCookies(page);
  const dom = (await page.evaluate(DETECT_DOM_SOURCE)) as {
    loggedIn: boolean;
    signals: {
      visibleLoginCta: boolean;
      hasLoginForm: boolean;
      logout: boolean;
      myName: boolean;
      myNameText: string;
      mailOrNoti: boolean;
      positive: boolean;
      loggedOut: boolean;
    };
  };

  // Cookies are source of truth (same as app login.ts); DOM backs them up.
  const loggedIn = cookies.ok || dom.loggedIn;

  const result: NaverSessionCheckResult = {
    ok: loggedIn,
    loggedIn,
    url,
    title,
    signals: {
      visibleLoginCta: dom.signals.visibleLoginCta,
      hasLoginForm: dom.signals.hasLoginForm,
      logout: dom.signals.logout,
      myName: dom.signals.myName,
      myNameText: dom.signals.myNameText,
      mailOrNoti: dom.signals.mailOrNoti,
      authCookies: cookies.ok,
      authCookieNames: cookies.names,
    },
  };

  if (!loggedIn) {
    result.error =
      "네이버에 로그인되어 있지 않습니다. CDP Chrome 창에서 www.naver.com 에 로그인한 뒤 다시 실행하세요.";
  }

  return result;
}

/**
 * Full check: CDP connect → new page → naver.com → login probe → close page.
 */
export async function checkNaverSession(
  existing?: CdpConnection,
): Promise<NaverSessionCheckResult> {
  const ownsConnection = !existing;
  let conn: CdpConnection;

  try {
    conn = existing ?? (await connectOverCdp(resolveCdpUrl()));
  } catch (err) {
    const classified = classifyCdpConnectError(err);
    console.error(`[cdp-worker:naver] FAIL ${classified.code}`);
    console.error(`[cdp-worker:naver] ${classified.message}`);
    return {
      ok: false,
      loggedIn: false,
      url: "",
      title: "",
      signals: {
        visibleLoginCta: false,
        hasLoginForm: false,
        logout: false,
        myName: false,
        myNameText: "",
        mailOrNoti: false,
        authCookies: false,
        authCookieNames: [],
      },
      error: classified.message,
    };
  }

  let page: Page | null = null;
  try {
    page = await conn.context.newPage();
    const result = await probeOnPage(page);

    if (result.loggedIn) {
      console.info("[cdp-worker:naver] login: OK", {
        authCookies: result.signals.authCookies,
        myName: result.signals.myNameText || undefined,
      });
    } else {
      console.error("[cdp-worker:naver] FAIL naver_not_logged_in");
      console.error(`[cdp-worker:naver] ${result.error}`);
      console.info("[cdp-worker:naver] signals", result.signals);
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cdp-worker:naver] FAIL probe_error");
    console.error(`[cdp-worker:naver] ${message}`);
    return {
      ok: false,
      loggedIn: false,
      url: page?.url() ?? "",
      title: "",
      signals: {
        visibleLoginCta: false,
        hasLoginForm: false,
        logout: false,
        myName: false,
        myNameText: "",
        mailOrNoti: false,
        authCookies: false,
        authCookieNames: [],
      },
      error: message,
    };
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (ownsConnection) {
      await disconnectCdp(conn!);
    }
  }
}

/** Optional helper if caller already has a context. */
export async function checkNaverSessionOnContext(
  context: BrowserContext,
): Promise<NaverSessionCheckResult> {
  const page = await context.newPage();
  try {
    return await probeOnPage(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}
