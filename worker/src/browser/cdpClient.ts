/**
 * Chrome CDP attach — same approach as BrowserSessionManager.getContextViaCdp.
 * Env: CDP_URL (default http://127.0.0.1:9222)
 *
 * Chrome itself must be started via scripts/start-cdp-chrome.sh with a
 * dedicated worker profile (never the user's default Chrome profile).
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
} from "playwright";

export type CdpConnection = {
  browser: Browser;
  context: BrowserContext;
  cdpUrl: string;
};

export function resolveCdpUrl(): string {
  return process.env.CDP_URL?.trim() || "http://127.0.0.1:9222";
}

/**
 * Connect to an already-running Chrome with remote debugging.
 * Does not launch a new browser (matches app USE_CDP=true path).
 */
export async function connectOverCdp(
  cdpUrl = resolveCdpUrl(),
): Promise<CdpConnection> {
  console.info(`[cdp-worker] connectOverCDP url=${cdpUrl}`);
  try {
    const browser = await chromium.connectOverCDP(cdpUrl, {
      timeout: Number(process.env.ACTION_TIMEOUT ?? 90_000) || 90_000,
      noDefaults: true,
    });
    const contexts = browser.contexts();
    if (!contexts.length) {
      await browser.close().catch(() => undefined);
      throw new Error(
        "connectOverCDP: browser.contexts() is empty — start Chrome with scripts/start-cdp-chrome.sh (dedicated profile, headless)",
      );
    }
    const context = contexts[0]!;
    console.info(
      `[cdp-worker] Chrome CDP connected contexts=${contexts.length} pages=${context.pages().length} (reuse existing session — no new visible window)`,
    );
    return { browser, context, cdpUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ECONNREFUSED|Timeout|Target closed|connect/i.test(msg)) {
      console.error(
        `[cdp-worker] CDP connect failed: ${msg}`,
      );
      console.error(
        "[cdp-worker] Hint: run ./scripts/start-cdp-chrome.sh — uses ~/ai-sns-manager/chrome-profile (not default Chrome profile). Profile lock / dual Chrome on same dir causes: \"Chrome에서 프로필을 여는 동안 문제가 발생했습니다\".",
      );
    }
    throw err;
  }
}

export async function disconnectCdp(conn: CdpConnection): Promise<void> {
  // Do not close the user's Chrome — only detach the Playwright connection.
  try {
    await conn.browser.close();
  } catch {
    // ignore detach errors
  }
  console.info("[cdp-worker] CDP detached (Chrome left running)");
}
