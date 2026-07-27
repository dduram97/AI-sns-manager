/**
 * Interactive Naver login for persistent Playwright profile.
 * Keeps the browser open until login succeeds (CAPTCHA-friendly).
 *
 * Usage:
 *   npm run naver:login
 *
 * After success, re-run:
 *   npm run verify:naver:actions -- --action like --execute
 */

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env" });

// Must set before BrowserSessionManager is constructed
process.env.BROWSER_HEADLESS = "false";
const waitMs = Number(process.env.NAVER_LOGIN_WAIT_MS ?? 600_000);
process.env.NAVER_LOGIN_WAIT_MS = String(waitMs);
process.env.ACTION_TIMEOUT = String(
  Math.max(Number(process.env.ACTION_TIMEOUT ?? 0), waitMs + 60_000),
);

const { getNaverBrowserSession } =
  await import("../src/adapters/browser/BrowserSessionManager.js");
const { ensureNaverLogin, probeNaverLoginState } =
  await import("../src/adapters/naver/login.js");

async function main() {
  console.log("=== naver:login ===");
  console.log(`profile=${process.env.NAVER_BROWSER_PROFILE ?? "(default)"}`);
  console.log(`waitMs=${waitMs}`);
  console.log("브라우저가 열리면 네이버에 직접 로그인하세요 (캡차 포함).");
  console.log("로그인 완료를 감지하면 세션을 저장하고 종료합니다.\n");

  const session = getNaverBrowserSession();
  const page = await session.newPage();
  try {
    const probed = await probeNaverLoginState(session, page);
    console.log(`[naver:login] probe=${probed}`);
    if (probed === "logged_in") {
      console.log("[naver:login] 이미 로그인되어 있습니다.");
      await session.saveCookies();
      return;
    }

    console.log("[naver:login] 로그인 필요 — 브라우저에서 로그인하세요.");
    await ensureNaverLogin(session, page);

    const again = await probeNaverLoginState(session, page);
    if (again !== "logged_in") {
      throw new Error(
        "로그인 확인 실패 — 브라우저에서 로그인 후 다시 실행하세요",
      );
    }

    console.log("[naver:login] 로그인 성공 · 세션/쿠키 저장 완료");
  } finally {
    await page.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(
    "[naver:login] FAILED:",
    err instanceof Error ? err.message : err,
  );
  process.exitCode = 1;
});
