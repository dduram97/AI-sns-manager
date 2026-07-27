/**
 * Playwright Browser Session Manager
 * - login session state
 * - single BrowserContext reuse
 * - action / navigation timeouts
 * - failure-safe close
 *
 * Session modes (env; default unchanged — CDP only when USE_CDP=true|1|yes):
 * - Primary (ops / Like): USE_CDP=true → connectOverCDP(CDP_URL)
 *   Requires Chrome already running with --remote-debugging-port on a
 *   *non-default* --user-data-dir (Chrome blocks CDP on the Default profile path).
 * - Fallback / debug: USE_CDP unset|false → launchPersistentContext(naver-profile)
 *   + optional cookie jar. Kept for smoke tests; Naver Like often fails here
 *   because the session is not the daily Chrome login.
 *
 * Mac: resolve Chromium executable robustly (arm64 path / system Chrome fallback).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Cookie,
  type Page,
} from "playwright";

type LaunchPersistentContextOptions = Parameters<
  typeof chromium.launchPersistentContext
>[1];

export interface BrowserSessionOptions {
  /** Persistent Chromium profile directory */
  userDataDir?: string;
  /** Cookie jar JSON path (backup / restore) */
  cookiePath?: string;
  headless?: boolean;
  channel?: "chromium" | "chrome" | "msedge";
  /** Default per-action timeout (ms) */
  actionTimeoutMs?: number;
  /** Navigation timeout (ms) */
  navigationTimeoutMs?: number;
  /**
   * Attach to an already-running Chrome via CDP instead of launchPersistentContext.
   * When omitted: enabled only if env USE_CDP is true|1|yes (no implicit default on).
   * CDP_URL defaults to http://127.0.0.1:9222.
   */
  useCdp?: boolean;
  cdpUrl?: string;
}

function envFlagTrue(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export type SessionLoginState =
  | "unknown"
  | "logged_in"
  | "logged_out"
  | "error";

const DEFAULT_USER_DATA = path.join(
  process.cwd(),
  ".data",
  "browser",
  "naver-profile",
);
const DEFAULT_COOKIE_PATH = path.join(
  process.cwd(),
  ".data",
  "browser",
  "naver-cookies.json",
);

const MAC_CHROME_APP =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function existsExec(p: string | null | undefined): p is string {
  return Boolean(p && fs.existsSync(p));
}

/** Prefer arm64 Chrome-for-Testing when Node/Playwright mis-reports x64 path on Apple Silicon. */
function fixMacArchPath(candidate: string): string {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    return candidate;
  if (candidate.includes("chrome-mac-x64")) {
    const arm = candidate.replace("chrome-mac-x64", "chrome-mac-arm64");
    if (existsExec(arm)) return arm;
  }
  return candidate;
}

function defaultMsPlaywrightDir(): string {
  return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
}

function findChromeForTestingUnder(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  const preferred =
    process.arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
  const fallback =
    process.arch === "arm64" ? "chrome-mac-x64" : "chrome-mac-arm64";
  try {
    const entries = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("chromium-"));
    // newest revision first
    entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const rev of entries) {
      for (const folder of [preferred, fallback]) {
        const exe = path.join(
          root,
          rev,
          folder,
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        );
        if (existsExec(exe)) return exe;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

type LaunchPlan = {
  mode: "executablePath" | "channel-chrome" | "bundled";
  executablePath?: string;
  channel?: "chrome" | "msedge";
};

/**
 * Resolve a launch plan that works on Mac even when:
 * - PLAYWRIGHT_BROWSERS_PATH points at an empty Cursor sandbox cache
 * - Playwright reports chrome-mac-x64 on arm64
 */
export function resolveBrowserLaunchPlan(): LaunchPlan {
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "(unset)";
  let bundled: string | null = null;
  try {
    bundled = fixMacArchPath(chromium.executablePath());
  } catch {
    bundled = null;
  }

  console.log(
    `[BrowserSessionManager] platform=${process.platform} arch=${process.arch}`,
  );
  console.log(`[BrowserSessionManager] PLAYWRIGHT_BROWSERS_PATH=${envPath}`);
  console.log(
    `[BrowserSessionManager] chromium.executablePath(raw)=${(() => {
      try {
        return chromium.executablePath();
      } catch (e) {
        return `(error: ${e instanceof Error ? e.message : e})`;
      }
    })()}`,
  );
  console.log(
    `[BrowserSessionManager] resolvedBundled=${bundled ?? "(none)"} exists=${existsExec(bundled)}`,
  );

  // 1) Bundled / resolved Playwright Chromium
  if (existsExec(bundled)) {
    return { mode: "executablePath", executablePath: bundled };
  }

  // 2) If env browsers path is broken, look in default ms-playwright cache
  const fromHome = findChromeForTestingUnder(defaultMsPlaywrightDir());
  console.log(
    `[BrowserSessionManager] ms-playwright home candidate=${fromHome ?? "(none)"} exists=${existsExec(fromHome)}`,
  );
  if (existsExec(fromHome)) {
    return { mode: "executablePath", executablePath: fromHome };
  }

  // 3) System Google Chrome via channel (recommended on Mac)
  if (process.platform === "darwin" && existsExec(MAC_CHROME_APP)) {
    console.log(
      `[BrowserSessionManager] falling back to channel=chrome path=${MAC_CHROME_APP}`,
    );
    return { mode: "channel-chrome", channel: "chrome" };
  }

  // 4) Explicit Chrome.app executablePath
  if (existsExec(MAC_CHROME_APP)) {
    return { mode: "executablePath", executablePath: MAC_CHROME_APP };
  }

  // Last resort: let Playwright try bundled (will throw with install hint)
  return { mode: "bundled" };
}

/**
 * Playwright Browser Session Manager
 * - Primary: USE_CDP=true → connectOverCDP (real Chrome session; required for Like)
 * - Fallback: otherwise → launchPersistentContext (naver-profile; debug/smoke)
 */
export class BrowserSessionManager {
  private context: BrowserContext | null = null;
  /** CDP-connected Browser handle (null in launchPersistentContext mode) */
  private cdpBrowser: Browser | null = null;
  private loginState: SessionLoginState = "unknown";
  private lastError: string | null = null;
  private readonly userDataDir: string;
  private readonly cookiePath: string;
  private readonly headless: boolean;
  private readonly channel: BrowserSessionOptions["channel"];
  private readonly useCdp: boolean;
  private readonly cdpUrl: string;
  readonly actionTimeoutMs: number;
  readonly navigationTimeoutMs: number;

  constructor(options: BrowserSessionOptions = {}) {
    this.userDataDir =
      options.userDataDir ??
      process.env.NAVER_BROWSER_PROFILE ??
      process.env.BROWSER_USER_DATA_DIR ??
      DEFAULT_USER_DATA;
    this.cookiePath =
      options.cookiePath ??
      process.env.BROWSER_COOKIE_PATH ??
      DEFAULT_COOKIE_PATH;
    this.headless =
      options.headless ??
      (process.env.BROWSER_HEADLESS !== "false" &&
        process.env.BROWSER_HEADLESS !== "0");
    // Prefer explicit option; env can override; default system Google Chrome
    const envChannel = process.env.NAVER_BROWSER_CHANNEL?.trim() as
      | BrowserSessionOptions["channel"]
      | undefined;
    this.channel = options.channel ?? envChannel ?? "chrome";
    this.useCdp = options.useCdp ?? envFlagTrue("USE_CDP");
    this.cdpUrl =
      options.cdpUrl?.trim() ||
      process.env.CDP_URL?.trim() ||
      "http://127.0.0.1:9222";
    this.actionTimeoutMs =
      options.actionTimeoutMs ??
      envInt("ACTION_TIMEOUT", envInt("BROWSER_ACTION_TIMEOUT_MS", 90_000));
    // Headful: allow time for CAPTCHA / manual login inside ensureNaverLogin
    if (!this.headless) {
      const loginWait = envInt("NAVER_LOGIN_WAIT_MS", 300_000);
      this.actionTimeoutMs = Math.max(this.actionTimeoutMs, loginWait + 60_000);
    }
    this.navigationTimeoutMs =
      options.navigationTimeoutMs ?? envInt("BROWSER_NAV_TIMEOUT_MS", 45_000);
  }

  /** True when attached to user Chrome via CDP (no dedicated profile launch). */
  usesCdp(): boolean {
    return this.useCdp;
  }

  getLoginState(): SessionLoginState {
    return this.loginState;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  setLoginState(state: SessionLoginState, error?: string | null): void {
    this.loginState = state;
    this.lastError = error ?? null;
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context) {
      // Reuse; recover if browser was closed externally
      try {
        this.context.pages();
        return this.context;
      } catch {
        this.context = null;
        this.cdpBrowser = null;
        this.loginState = "unknown";
      }
    }

    if (this.useCdp) {
      return this.getContextViaCdp();
    }
    return this.getContextViaLaunch();
  }

  /** Attach to already-running Chrome (USE_CDP=true). */
  private async getContextViaCdp(): Promise<BrowserContext> {
    console.log(
      `[BrowserSessionManager] connectOverCDP url=${this.cdpUrl} (USE_CDP=true)`,
    );
    try {
      this.cdpBrowser = await chromium.connectOverCDP(this.cdpUrl, {
        timeout: this.actionTimeoutMs,
        // Do not override the user's daily-driver context defaults
        noDefaults: true,
      });
      const contexts = this.cdpBrowser.contexts();
      if (!contexts.length) {
        throw new Error(
          "connectOverCDP: browser.contexts() is empty — is Chrome running with --remote-debugging-port?",
        );
      }
      this.context = contexts[0];
      this.context.setDefaultTimeout(this.actionTimeoutMs);
      this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      // Chrome profile is source of truth — do not restoreCookies()
      console.log(
        `[BrowserSessionManager] CDP connect OK contexts=${contexts.length} pages=${this.context.pages().length}`,
      );
      await this.logCdpIdentity();
      return this.context;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.loginState = "error";
      this.context = null;
      this.cdpBrowser = null;
      throw new Error(
        `BrowserSessionManager CDP connect failed: ${this.lastError}` +
          ` | start Chrome with --remote-debugging-port=9222 on a *non-default* --user-data-dir` +
          ` (e.g. $HOME/chrome-cdp-profile), confirm http://127.0.0.1:9222/json/version, set USE_CDP=true and CDP_URL`,
      );
    }
  }

  /** Existing path: launchPersistentContext + optional cookie jar. */
  private async getContextViaLaunch(): Promise<BrowserContext> {
    fs.mkdirSync(this.userDataDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.cookiePath), { recursive: true });

    const plan = resolveBrowserLaunchPlan();
    // Do not override userAgent — use the launched browser's real UA.
    const launchOpts: LaunchPersistentContextOptions = {
      headless: this.headless,
      viewport: { width: 1280, height: 900 },
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      // m.blog LikeIt often expects touch-capable input (page.touchscreen / pointerType=touch)
      hasTouch: true,
      isMobile: false,
      args: ["--disable-blink-features=AutomationControlled"],
      timeout: this.actionTimeoutMs,
    };

    // Default / preferred: system Google Chrome via channel
    if (this.channel === "chrome" || this.channel === "msedge") {
      launchOpts.channel = this.channel;
      console.log(
        `[BrowserSessionManager] launchPersistentContext channel=${this.channel} userDataDir=${this.userDataDir}`,
      );
    } else if (plan.mode === "executablePath" && plan.executablePath) {
      launchOpts.executablePath = plan.executablePath;
      console.log(
        `[BrowserSessionManager] launchPersistentContext executablePath=${plan.executablePath} userDataDir=${this.userDataDir}`,
      );
    } else if (plan.mode === "channel-chrome") {
      launchOpts.channel = "chrome";
      console.log(
        `[BrowserSessionManager] launchPersistentContext channel=chrome userDataDir=${this.userDataDir}`,
      );
    } else {
      // Last resort: still prefer system Chrome over bundled Chromium-for-Testing
      launchOpts.channel = "chrome";
      console.log(
        `[BrowserSessionManager] launchPersistentContext channel=chrome (fallback from ${this.channel}) userDataDir=${this.userDataDir}`,
      );
    }

    try {
      this.context = await chromium.launchPersistentContext(
        this.userDataDir,
        launchOpts,
      );
      this.context.setDefaultTimeout(this.actionTimeoutMs);
      this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      await this.restoreCookies();
      console.log("[BrowserSessionManager] launch OK");
      await this.logBrowserIdentity(launchOpts);
      return this.context;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.loginState = "error";
      this.context = null;

      // One more fallback: system Chrome channel if not already tried
      if (launchOpts.channel !== "chrome" && existsExec(MAC_CHROME_APP)) {
        console.warn(
          `[BrowserSessionManager] primary launch failed (${this.lastError.slice(0, 120)}) — retry channel=chrome`,
        );
        try {
          this.context = await chromium.launchPersistentContext(
            this.userDataDir,
            {
              ...launchOpts,
              executablePath: undefined,
              channel: "chrome",
            },
          );
          this.context.setDefaultTimeout(this.actionTimeoutMs);
          this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
          await this.restoreCookies();
          console.log(
            "[BrowserSessionManager] launch OK (channel=chrome fallback)",
          );
          await this.logBrowserIdentity({
            ...launchOpts,
            executablePath: undefined,
            channel: "chrome",
          });
          return this.context;
        } catch (err2) {
          this.lastError = err2 instanceof Error ? err2.message : String(err2);
        }
      }

      throw new Error(
        `BrowserSessionManager launch failed: ${this.lastError}` +
          ` | hint: install Google Chrome or set NAVER_BROWSER_CHANNEL=chrome`,
      );
    }
  }

  private async logCdpIdentity(): Promise<void> {
    let browserVersion = "(unknown)";
    try {
      browserVersion = this.cdpBrowser?.version() ?? "(no version)";
    } catch {
      browserVersion = "(error)";
    }
    console.log("========== BROWSER IDENTITY (CDP) ==========");
    console.log(`mode: connectOverCDP (primary — real Chrome session)`);
    console.log(`CDP_URL: ${this.cdpUrl}`);
    console.log(`Browser version: ${browserVersion}`);
    console.log(`channel: (attached Chrome — not launched by Playwright)`);
    console.log(
      `fallback: set USE_CDP=false for launchPersistentContext(naver-profile)`,
    );
    console.log("===========================================");
  }

  /** Print launch identity (channel / UA) — no profile switching. */
  private async logBrowserIdentity(
    launchOpts: NonNullable<LaunchPersistentContextOptions> = {},
  ): Promise<void> {
    if (!this.context) return;
    const channel = String(launchOpts?.channel ?? "(none)");
    const executablePath = String(
      launchOpts?.executablePath ??
        (channel === "chrome" ? MAC_CHROME_APP : "(bundled/unknown)"),
    );
    let browserVersion = "(unknown)";
    try {
      browserVersion =
        this.context.browser()?.version() ?? "(persistent/no browser())";
    } catch {
      browserVersion = "(error reading version)";
    }

    let userAgent = "(unread)";
    let userAgentData: unknown = null;
    const page = await this.context.newPage();
    try {
      await page
        .goto("about:blank", { timeout: 10_000 })
        .catch(() => undefined);
      const id = (await page.evaluate(`(() => {
        var uad = null;
        try {
          if (navigator.userAgentData) {
            uad = {
              brands: navigator.userAgentData.brands,
              mobile: navigator.userAgentData.mobile,
              platform: navigator.userAgentData.platform
            };
          }
        } catch (e) {
          uad = { error: String(e) };
        }
        return { userAgent: navigator.userAgent, userAgentData: uad };
      })()`)) as { userAgent?: string; userAgentData?: unknown };
      userAgent = id.userAgent ?? "(empty)";
      userAgentData = id.userAgentData;
    } catch (err) {
      userAgent = `error: ${err instanceof Error ? err.message : err}`;
    } finally {
      await page.close().catch(() => undefined);
    }

    console.log("========== BROWSER IDENTITY ==========");
    console.log(`Browser version: ${browserVersion}`);
    console.log(`navigator.userAgent: ${userAgent}`);
    console.log(`navigator.userAgentData: ${JSON.stringify(userAgentData)}`);
    console.log(`executablePath: ${executablePath}`);
    console.log(`channel: ${channel}`);
    console.log("======================================");
  }

  async newPage(): Promise<Page> {
    const acquired = await this.acquireWorkPage();
    // Legacy callers that always close — mark ephemeral so close is safe.
    if (!acquired.ephemeral) {
      // Caller may close; ignore. Prefer acquireWorkPage/releaseWorkPage.
    }
    return acquired.page;
  }

  /**
   * Prefer an existing tab when attached via CDP (no new window/tab).
   * Persistent-profile mode still opens an ephemeral page (closed after work).
   */
  async acquireWorkPage(): Promise<{ page: Page; ephemeral: boolean }> {
    const context = await this.getContext();
    if (this.useCdp) {
      const existing = context.pages().find((p) => !p.isClosed());
      if (existing) {
        existing.setDefaultTimeout(this.actionTimeoutMs);
        existing.setDefaultNavigationTimeout(this.navigationTimeoutMs);
        console.log(
          "[BrowserSessionManager] reuse existing CDP page (no new tab)",
        );
        return { page: existing, ephemeral: false };
      }
      console.log(
        "[BrowserSessionManager] CDP has no pages — creating one work tab",
      );
    }
    const page = await context.newPage();
    page.setDefaultTimeout(this.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    return { page, ephemeral: true };
  }

  /** Close only ephemeral pages created for a single action. */
  async releaseWorkPage(
    page: Page | null | undefined,
    ephemeral: boolean,
  ): Promise<void> {
    if (!page || !ephemeral) return;
    await page.close().catch(() => undefined);
  }

  /**
   * Run work with hard timeout. On failure, records lastError and rethrows.
   */
  async runWithTimeout<T>(
    label: string,
    work: () => Promise<T>,
    timeoutMs = this.actionTimeoutMs,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `BrowserSessionManager timeout (${timeoutMs}ms): ${label}`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      return result;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async saveCookies(): Promise<void> {
    if (this.useCdp) {
      // Chrome profile is source of truth — skip jar write
      return;
    }
    if (!this.context) return;
    try {
      const cookies = await this.context.cookies();
      fs.mkdirSync(path.dirname(this.cookiePath), { recursive: true });
      fs.writeFileSync(
        this.cookiePath,
        JSON.stringify(cookies, null, 2),
        "utf8",
      );
    } catch (err) {
      console.warn(
        "[BrowserSessionManager] cookie save failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async restoreCookies(): Promise<void> {
    if (this.useCdp) {
      // Never inject jar cookies into the user's Chrome session
      return;
    }
    if (!this.context) return;
    if (!fs.existsSync(this.cookiePath)) return;
    try {
      const raw = fs.readFileSync(this.cookiePath, "utf8");
      const cookies = JSON.parse(raw) as Cookie[];
      if (Array.isArray(cookies) && cookies.length > 0) {
        await this.context.addCookies(cookies);
      }
    } catch (err) {
      console.warn(
        "[BrowserSessionManager] cookie restore failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async close(): Promise<void> {
    if (this.useCdp) {
      // Do NOT call browser.close() or context.close() — CDP Browser.close
      // can quit the user's Chrome. Drop handles only; Chrome stays open.
      this.context = null;
      this.cdpBrowser = null;
      console.log(
        "[BrowserSessionManager] CDP handles cleared (user Chrome left running; no browser.close)",
      );
      return;
    }

    if (!this.context) return;
    try {
      await this.saveCookies();
    } catch {
      // ignore
    }
    try {
      await this.context.close();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.context = null;
    }
  }
}

let sharedSession: BrowserSessionManager | null = null;

export function getNaverBrowserSession(): BrowserSessionManager {
  if (!sharedSession) {
    sharedSession = new BrowserSessionManager();
  }
  return sharedSession;
}

/** Test helper — drop singleton so next launch uses fresh options */
export function resetNaverBrowserSession(): void {
  sharedSession = null;
}
