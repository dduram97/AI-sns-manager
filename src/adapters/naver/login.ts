/**
 * Ensure Naver session is logged in.
 * Detects expiry / CAPTCHA and persists session health for Live ops.
 */

import type { Page } from "playwright";
import type { BrowserSessionManager } from "../browser/BrowserSessionManager";
import { writeSessionHealth } from "./sessionHealth";

const LOGIN_URL =
  "https://nid.naver.com/nidlogin.login?mode=form&url=https://www.naver.com/";

function isHeadful(): boolean {
  return (
    process.env.BROWSER_HEADLESS === "false" ||
    process.env.BROWSER_HEADLESS === "0"
  );
}

function interactiveLoginWaitMs(): number {
  const raw = process.env.NAVER_LOGIN_WAIT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 300_000; // 5 minutes
}

/** Auth cookies are the source of truth — DOM on www.naver.com often false-negatives. */
async function hasNaverAuthCookies(page: Page): Promise<{
  ok: boolean;
  names: string[];
}> {
  const cookies = await page
    .context()
    .cookies([
      "https://www.naver.com/",
      "https://nid.naver.com/",
      "https://m.blog.naver.com/",
    ]);
  const names = cookies.map((c) => c.name);
  const hasAut = names.includes("NID_AUT");
  const hasSes = names.includes("NID_SES");
  return {
    ok: hasAut && hasSes,
    names: names.filter((n) => n.startsWith("NID_") || n === "nid_inf"),
  };
}

/** String sources — avoid tsx/esbuild __name injection into page.evaluate */
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

  // Visible login CTA only (hidden template links do not count)
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

const DETECT_LOGIN_FORM_SOURCE = `(() => {
  return !!(document.querySelector('#id, #pw, .login_form, input[name="id"]'));
})()`;

async function detectLoggedIn(page: Page): Promise<boolean> {
  const cookies = await hasNaverAuthCookies(page);
  if (cookies.ok) {
    console.log(
      `[naver:login] detectLoggedIn=true via cookies=${cookies.names.join(",")}`,
    );
    return true;
  }

  const result = (await page.evaluate(DETECT_DOM_SOURCE)) as {
    loggedIn: boolean;
    signals: Record<string, unknown>;
  };

  console.log(
    `[naver:login] detectLoggedIn=${result.loggedIn} cookies=missing signals=${JSON.stringify(result.signals)}`,
  );
  return result.loggedIn;
}

async function detectLoginPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (
    url.includes("nidlogin.login") ||
    /nid\.naver\.com\/nidlogin\.login/.test(url)
  ) {
    return true;
  }
  return page.evaluate(DETECT_LOGIN_FORM_SOURCE) as Promise<boolean>;
}

/**
 * Soft session check without full login flow.
 */
export async function probeNaverLoginState(
  session: BrowserSessionManager,
  page: Page,
): Promise<"logged_in" | "logged_out" | "expired"> {
  await page.goto("https://www.naver.com/", {
    waitUntil: "domcontentloaded",
    timeout: session.navigationTimeoutMs,
  });
  // Give account widget a moment to hydrate
  await new Promise((r) => setTimeout(r, 1_200));

  // Cookies first — avoid false "logged_out" that triggers re-login and kills session
  const cookies = await hasNaverAuthCookies(page);
  if (cookies.ok) {
    console.log(
      `[naver:login] probe=logged_in (cookies=${cookies.names.join(",")})`,
    );
    return "logged_in";
  }

  if (await detectLoginPage(page)) {
    console.log("[naver:login] probe=expired (login form)");
    return "expired";
  }
  if (await detectLoggedIn(page)) {
    console.log("[naver:login] probe=logged_in (dom)");
    return "logged_in";
  }
  console.log("[naver:login] probe=logged_out");
  return "logged_out";
}

/**
 * Keep browser open and poll until user finishes login (CAPTCHA / 2FA).
 * Does NOT navigate away if already on a useful page — only opens login when needed.
 */
async function waitForInteractiveLogin(
  session: BrowserSessionManager,
  page: Page,
  reason: string,
): Promise<boolean> {
  if (!isHeadful()) return false;

  const waitMs = interactiveLoginWaitMs();
  const deadline = Date.now() + waitMs;
  console.log(
    `[naver:login] ${reason}\n` +
      `  → 열린 브라우저에서 직접 로그인하세요 (캡차/추가인증 포함).\n` +
      `  → 이미 로그인되어 있으면 그대로 두세요. 쿠키가 잡히면 자동으로 이어갑니다.\n` +
      `  → 최대 ${Math.round(waitMs / 1000)}초 동안 대기합니다.`,
  );

  // Only go to login form if we are clearly not logged in and not already there
  const cookies = await hasNaverAuthCookies(page);
  if (!cookies.ok && !(await detectLoginPage(page))) {
    const url = page.url();
    if (!url.includes("naver.com") || url === "about:blank") {
      await page
        .goto(LOGIN_URL, {
          waitUntil: "domcontentloaded",
          timeout: session.navigationTimeoutMs,
        })
        .catch(() => undefined);
    }
  }

  while (Date.now() < deadline) {
    if (await detectLoggedIn(page)) {
      console.log("[naver:login] 수동 로그인 감지됨");
      return true;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function tryAutoLogin(
  session: BrowserSessionManager,
  page: Page,
  id: string,
  password: string,
): Promise<boolean> {
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: session.navigationTimeoutMs,
  });

  const idBox = page.locator("#id");
  const pwBox = page.locator("#pw");
  await idBox.click({ timeout: 15_000 });
  await page.keyboard.insertText(id);
  await pwBox.click();
  await page.keyboard.insertText(password);

  // Never use generic button[type=submit] — matches search buttons on other pages
  const loginBtn = page.locator("#log\\.login, button.btn_login").first();
  await Promise.all([
    page
      .waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: session.navigationTimeoutMs,
      })
      .catch(() => null),
    loginBtn.click({ timeout: 15_000 }),
  ]);

  return detectLoggedIn(page);
}

/**
 * Ensure Naver session is logged in.
 * Reuses cookies / persistent profile; falls back to NAVER_ID / NAVER_PASSWORD.
 * On CAPTCHA / failed auto-login with BROWSER_HEADLESS=false, waits for manual login.
 *
 * Important: never force re-login when NID_AUT/NID_SES already exist.
 */
export async function ensureNaverLogin(
  session: BrowserSessionManager,
  page: Page,
): Promise<void> {
  const probed = await probeNaverLoginState(session, page);
  if (probed === "logged_in") {
    session.setLoginState("logged_in");
    writeSessionHealth("logged_in");
    await session.saveCookies();
    return;
  }

  // CDP: attached Chrome is the session — never auto/manual re-login here
  if (session.usesCdp()) {
    const msg =
      "CDP mode: Naver is not logged in on the attached Chrome. " +
      "Log in manually in that Chrome window, then retry (no auto re-login).";
    session.setLoginState("error", msg);
    writeSessionHealth("needs_relogin", msg);
    throw new Error(msg);
  }

  if (probed === "expired") {
    session.setLoginState("logged_out", "session_expired");
    writeSessionHealth("expired", "Naver session expired — re-login required");
  } else {
    session.setLoginState("logged_out");
    writeSessionHealth("logged_out", "Naver not logged in");
  }

  const id = process.env.NAVER_ID?.trim();
  const password = process.env.NAVER_PASSWORD?.trim();

  // Headful: do NOT auto-submit credentials (often logs out a good session + hits CAPTCHA).
  // Wait for the user; cookies/DOM will flip when login sticks.
  if (isHeadful()) {
    const ok = await waitForInteractiveLogin(
      session,
      page,
      id && password
        ? "세션 미확인 — 브라우저에서 로그인 상태를 확인하세요 (자동 재로그인 안 함)"
        : "NAVER_ID/PASSWORD 없음 — 수동 로그인 필요",
    );
    if (ok) {
      session.setLoginState("logged_in");
      writeSessionHealth("logged_in");
      await session.saveCookies();
      return;
    }
    const msg =
      "Naver login required: finish login in the open browser, or run `npm run naver:login`";
    session.setLoginState("error", msg);
    writeSessionHealth("needs_relogin", msg);
    throw new Error(msg);
  }

  // Headless: try credentials once
  if (!id || !password) {
    const msg =
      "Naver login required: set NAVER_ID / NAVER_PASSWORD or run `npm run naver:login` with BROWSER_HEADLESS=false";
    session.setLoginState("error", msg);
    writeSessionHealth("needs_relogin", msg);
    throw new Error(msg);
  }

  const autoOk = await tryAutoLogin(session, page, id, password);
  if (autoOk) {
    session.setLoginState("logged_in");
    writeSessionHealth("logged_in");
    await session.saveCookies();
    return;
  }

  const captcha = await page
    .locator("#captcha, .captcha")
    .count()
    .catch(() => 0);
  const msg =
    captcha > 0
      ? "Naver login blocked by CAPTCHA — run `npm run naver:login` (BROWSER_HEADLESS=false)"
      : "Naver login failed — run `npm run naver:login` or check credentials";
  session.setLoginState("error", msg);
  writeSessionHealth("needs_relogin", msg);
  throw new Error(msg);
}
