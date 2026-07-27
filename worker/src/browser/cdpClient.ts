/**
 * Chrome CDP attach — same approach as BrowserSessionManager.getContextViaCdp.
 * Env: CDP_URL (default http://127.0.0.1:9222)
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
  const browser = await chromium.connectOverCDP(cdpUrl, {
    timeout: Number(process.env.ACTION_TIMEOUT ?? 90_000) || 90_000,
    noDefaults: true,
  });
  const contexts = browser.contexts();
  if (!contexts.length) {
    await browser.close().catch(() => undefined);
    throw new Error(
      "connectOverCDP: browser.contexts() is empty — start Chrome with --remote-debugging-port (see scripts/start-cdp-chrome.sh)",
    );
  }
  const context = contexts[0]!;
  console.info(
    `[cdp-worker] Chrome CDP connected contexts=${contexts.length} pages=${context.pages().length}`,
  );
  return { browser, context, cdpUrl };
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
