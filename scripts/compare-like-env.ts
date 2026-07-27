/**
 * Read-only env comparison: Playwright session vs real Chrome expectations.
 * Does NOT change like/click/LikeIt logic.
 *
 * Usage:
 *   BROWSER_HEADLESS=false node --import tsx scripts/compare-like-env.ts
 */

import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import {
  getNaverBrowserSession,
  resetNaverBrowserSession,
} from "../src/adapters/browser/BrowserSessionManager";

const MAC_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Exact UA hardcoded in BrowserSessionManager (do not change that file — only report). */
const HARDCODED_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

type Row = {
  item: string;
  playwright: string;
  realChrome: string;
  note?: string;
};

function short(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function maskCookie(v: string): string {
  if (v.length <= 12) return `${v}(len=${v.length})`;
  return `${v.slice(0, 6)}…${v.slice(-4)}(len=${v.length})`;
}

function chromeVersion(): string {
  try {
    if (!fs.existsSync(MAC_CHROME)) return "(Chrome.app not found)";
    return execFileSync(MAC_CHROME, ["--version"], { encoding: "utf8" }).trim();
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : err}`;
  }
}

function listProfileHints(userDataDir: string): string {
  const parts: string[] = [];
  parts.push(`exists=${fs.existsSync(userDataDir)}`);
  if (!fs.existsSync(userDataDir)) return parts.join(", ");
  try {
    const kids = fs.readdirSync(userDataDir);
    parts.push(`entries=${kids.length}`);
    parts.push(
      `hasDefault=${kids.includes("Default")}`,
      `hasLocalState=${kids.includes("Local State")}`,
      `hasCookiesDb=${fs.existsSync(path.join(userDataDir, "Default", "Cookies")) || fs.existsSync(path.join(userDataDir, "Default", "Network", "Cookies"))}`,
    );
  } catch (err) {
    parts.push(`readdirErr=${err instanceof Error ? err.message : err}`);
  }
  return parts.join(", ");
}

function cookieSummary(
  cookies: Array<{ name: string; domain: string; value: string }>,
): string {
  const auth = cookies.filter((c) =>
    /^(NID_AUT|NID_SES|NID_JKL|NNB|NAC)$/.test(c.name),
  );
  if (!auth.length) return `total=${cookies.length}; auth=(none)`;
  return (
    `total=${cookies.length}; ` +
    auth.map((c) => `${c.name}@${c.domain}=${maskCookie(c.value)}`).join("; ")
  );
}

async function main() {
  const rows: Row[] = [];
  const realChromeVer = chromeVersion();
  const realChromeVerNum =
    realChromeVer.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ??
    realChromeVer.match(/(\d+\.\d+\.\d+)/)?.[1] ??
    "?";

  const realChromeUaGuess = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${realChromeVerNum} Safari/537.36`;

  const session = getNaverBrowserSession();
  const userDataDir =
    process.env.NAVER_BROWSER_PROFILE ??
    process.env.BROWSER_USER_DATA_DIR ??
    path.join(process.cwd(), ".data", "browser", "naver-profile");

  const headlessEnv = process.env.BROWSER_HEADLESS;
  const headless = headlessEnv !== "false" && headlessEnv !== "0";

  const channelEnv =
    process.env.NAVER_BROWSER_CHANNEL?.trim() || "(unset → chromium)";

  // Capture launch-related constants from code (reported, not modified)
  const launchOptsReported = {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    hasTouch: true,
    isMobile: false,
    userAgent: HARDCODED_UA,
    args: ["--disable-blink-features=AutomationControlled"],
    channel: channelEnv,
    userDataDir,
  };

  console.log("\n========== LIKE ENV COMPARE (read-only) ==========\n");
  console.log(
    "[launchPersistentContext options — as coded in BrowserSessionManager]",
  );
  console.log(JSON.stringify(launchOptsReported, null, 2));
  console.log(`\n[profile path] ${userDataDir}`);
  console.log(`[profile hints] ${listProfileHints(userDataDir)}`);
  console.log(
    `[realpath] ${fs.existsSync(userDataDir) ? fs.realpathSync(userDataDir) : "(missing)"}`,
  );

  let pageNavOk = false;
  let nav: Record<string, unknown> = {};
  let docCookie = "";
  let contextCookies: Array<{ name: string; domain: string; value: string }> =
    [];
  let browserVersion = "";
  let executablePathUsed = "";
  let channelUsed = "";

  try {
    const context = await session.getContext();
    // Infer what actually launched
    browserVersion =
      context.browser()?.version() ?? "(no browser() — persistent)";
    // Playwright persistent: browser() may exist
    try {
      const b = context.browser();
      if (b) browserVersion = b.version();
    } catch {
      // ignore
    }

    const page = await context.newPage();
    const target =
      process.env.VERIFY_NAVER_POST_URL?.trim() || "https://m.blog.naver.com/";
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
    pageNavOk = true;

    nav = (await page.evaluate(`(() => {
      var uad = null;
      try {
        if (navigator.userAgentData) {
          uad = {
            brands: navigator.userAgentData.brands,
            mobile: navigator.userAgentData.mobile,
            platform: navigator.userAgentData.platform
          };
          // high entropy if available (may prompt / empty in some builds)
        }
      } catch (e) {
        uad = { error: String(e) };
      }
      var pluginsLen = 0;
      try { pluginsLen = navigator.plugins ? navigator.plugins.length : 0; } catch (e) {}
      return {
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver,
        platform: navigator.platform,
        languages: navigator.languages ? Array.from(navigator.languages) : [],
        language: navigator.language,
        pluginsLength: pluginsLen,
        hardwareConcurrency: navigator.hardwareConcurrency,
        maxTouchPoints: navigator.maxTouchPoints,
        vendor: navigator.vendor,
        windowChrome: typeof window.chrome !== 'undefined',
        windowChromeKeys: (function() {
          try {
            if (!window.chrome) return null;
            return Object.keys(window.chrome).slice(0, 20);
          } catch (e) { return ['(inaccessible)']; }
        })(),
        userAgentData: uad,
        cookieEnabled: navigator.cookieEnabled
      };
    })()`)) as Record<string, unknown>;

    docCookie = (await page.evaluate(`(() => {
      try { return document.cookie || ''; } catch (e) { return '(error)'; }
    })()`)) as string;

    contextCookies = await context.cookies();

    // Try to read CDP Browser.getVersion
    try {
      const cdp = await context.newCDPSession(page);
      const ver = (await cdp.send("Browser.getVersion")) as {
        product?: string;
        userAgent?: string;
        jsVersion?: string;
      };
      rows.push({
        item: "CDP Browser.getVersion.product",
        playwright: String(ver.product ?? ""),
        realChrome: realChromeVer,
      });
      rows.push({
        item: "CDP Browser.getVersion.userAgent",
        playwright: short(String(ver.userAgent ?? ""), 100),
        realChrome: short(realChromeUaGuess, 100),
        note: "real = typical system Chrome UA guess from --version",
      });
      await cdp.detach().catch(() => undefined);
    } catch (err) {
      console.warn("[cdp] getVersion failed", err);
    }

    await page.close().catch(() => undefined);
  } finally {
    await session.close().catch(() => undefined);
    resetNaverBrowserSession();
  }

  // Resolve playwright version + bundled chromium path (without launching again)
  let pwVersion = "(unknown)";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "node_modules",
          "playwright",
          "package.json",
        ),
        "utf8",
      ),
    ) as { version?: string };
    pwVersion = pkg.version ?? "(unknown)";
  } catch {
    // ignore
  }

  let bundledExec = "";
  try {
    bundledExec = chromium.executablePath();
  } catch (err) {
    bundledExec = `error: ${err instanceof Error ? err.message : err}`;
  }

  // Build comparison table
  const pwUa = String(nav.userAgent ?? HARDCODED_UA);

  rows.push(
    {
      item: "1. User-Agent (effective navigator)",
      playwright: short(pwUa, 110),
      realChrome: short(realChromeUaGuess, 110),
      note: "Playwright forces hardcoded Chrome/122.0.0.0 in BrowserSessionManager",
    },
    {
      item: "2. User-Agent (launch option hardcoded)",
      playwright: short(HARDCODED_UA, 110),
      realChrome: short(realChromeUaGuess, 110),
      note: "Mismatch with real Chrome major version is expected",
    },
    {
      item: "3. navigator.webdriver",
      playwright: String(nav.webdriver),
      realChrome: "false (normal interactive Chrome)",
      note:
        nav.webdriver === true || nav.webdriver === "true"
          ? "DIFF: automation flag visible"
          : "ok-ish",
    },
    {
      item: "4. navigator.userAgentData",
      playwright: short(JSON.stringify(nav.userAgentData ?? null), 100),
      realChrome: `{"brands":[…Chrome ${realChromeVerNum.split(".")[0]}…],"mobile":false,"platform":"macOS"}`,
    },
    {
      item: "5. navigator.platform",
      playwright: String(nav.platform ?? ""),
      realChrome: "MacIntel (typical)",
    },
    {
      item: "6. navigator.languages",
      playwright: JSON.stringify(nav.languages ?? []),
      realChrome: '["ko-KR","ko"] or user prefs (locale ko-KR set in launch)',
    },
    {
      item: "7. navigator.plugins.length",
      playwright: String(nav.pluginsLength ?? ""),
      realChrome: ">0 typical (PDF viewer etc.) — Chromium-for-Testing often 0",
    },
    {
      item: "8. window.chrome exists",
      playwright: `${nav.windowChrome} keys=${JSON.stringify(nav.windowChromeKeys)}`,
      realChrome: "true (runtime, loadTimes, csi, …)",
    },
    {
      item: "9. document.cookie (page, Like-relevant names only)",
      playwright: summarizeDocCookie(docCookie),
      realChrome:
        "(open same URL in Chrome DevTools → Application → Cookies — compare NID_AUT/NID_SES presence)",
      note: "HttpOnly NID_AUT will NOT appear in document.cookie",
    },
    {
      item: "10. Playwright Context cookies (NID_*)",
      playwright: cookieSummary(contextCookies),
      realChrome:
        "DevTools: same profile cookies if same userDataDir; else Chrome default profile differs",
    },
    {
      item: "11. DevTools vs Context cookie source",
      playwright: `context.cookies() count=${contextCookies.length}`,
      realChrome: "Chrome DevTools cookie jar for profile in use",
      note: "If PW uses NAVER_BROWSER_PROFILE persistent dir, it is NOT your daily Chrome Default profile unless paths match",
    },
    {
      item: "12. Persistent profile path",
      playwright: userDataDir,
      realChrome: `~/Library/Application Support/Google/Chrome (default) — DIFFERENT unless you pointed NAVER_BROWSER_PROFILE there`,
      note: listProfileHints(userDataDir),
    },
    {
      item: "13. launchPersistentContext options",
      playwright: short(JSON.stringify(launchOptsReported), 140),
      realChrome: "n/a (manual Chrome has no Playwright launch opts)",
    },
    {
      item: "14. headless",
      playwright:
        String(headless) + ` (BROWSER_HEADLESS=${headlessEnv ?? "(unset)"})`,
      realChrome: "false",
    },
    {
      item: "15. channel",
      playwright: channelEnv,
      realChrome: "chrome (system)",
    },
    {
      item: "16. executablePath (Playwright bundled resolver)",
      playwright: bundledExec,
      realChrome: MAC_CHROME,
    },
    {
      item: "17. userDataDir",
      playwright: userDataDir,
      realChrome: path.join(
        os.homedir(),
        "Library/Application Support/Google/Chrome",
      ),
    },
    {
      item: "18. Browser version (Playwright context)",
      playwright: browserVersion || "(see CDP product row)",
      realChrome: realChromeVer,
    },
    {
      item: "19. Chrome version (system app)",
      playwright: "(PW may use Chromium-for-Testing, not this)",
      realChrome: realChromeVer,
    },
    {
      item: "20. Playwright version",
      playwright: pwVersion,
      realChrome: "n/a",
    },
    {
      item: "extra.hasTouch / isMobile / maxTouchPoints",
      playwright: `hasTouch=true isMobile=false maxTouchPoints=${nav.maxTouchPoints}`,
      realChrome: "desktop Chrome: hasTouch usually false, maxTouchPoints=0",
      note: "Fingerprint inconsistency: UA says desktop Mac but hasTouch=true",
    },
  );

  // Markdown table
  console.log(
    "\n| # | Item | Playwright (this run) | Real Chrome (system / typical) | Note |",
  );
  console.log(
    "|---|------|------------------------|--------------------------------|------|",
  );
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    console.log(
      `| ${i + 1} | ${esc(r.item)} | ${esc(r.playwright)} | ${esc(r.realChrome)} | ${esc(r.note ?? "")} |`,
    );
  }

  // Highlight diffs
  console.log("\n========== NOTABLE DIFFS ==========");
  console.log(`- Hardcoded UA Chrome/122 vs system Chrome ${realChromeVerNum}`);
  console.log(`- navigator.webdriver = ${nav.webdriver}`);
  console.log(`- plugins.length = ${nav.pluginsLength}`);
  console.log(`- window.chrome = ${nav.windowChrome}`);
  console.log(`- hasTouch=true with desktop UA (isMobile=false)`);
  console.log(
    `- Profile: PW=${userDataDir} vs default Chrome profile (usually different)`,
  );
  console.log(`- pageNavOk=${pageNavOk}`);
  console.log(`- document.cookie has NID_SES? ${/\bNID_SES=/.test(docCookie)}`);
  console.log(
    `- context has NID_AUT? ${contextCookies.some((c) => c.name === "NID_AUT")}`,
  );
  console.log(
    `- context has NID_SES? ${contextCookies.some((c) => c.name === "NID_SES")}`,
  );

  const out = path.join(
    process.cwd(),
    ".data",
    "debug",
    "sympathy",
    "like_env_compare.json",
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        launchOptsReported,
        nav,
        docCookieMasked: summarizeDocCookie(docCookie),
        contextCookieSummary: cookieSummary(contextCookies),
        contextAuthCookies: contextCookies
          .filter((c) => /NID_|NNB|NAC/.test(c.name))
          .map((c) => ({
            name: c.name,
            domain: c.domain,
            value: maskCookie(c.value),
          })),
        rows,
        realChromeVer,
        pwVersion,
        bundledExec,
        userDataDir,
        profileHints: listProfileHints(userDataDir),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[wrote] ${out}`);
  console.log("=================================================\n");
}

function summarizeDocCookie(raw: string): string {
  if (!raw) return "(empty)";
  const parts = raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const interesting = parts.filter((p) =>
    /^(NID_AUT|NID_SES|NID_JKL|NNB|NAC|nid_inf)=/i.test(p),
  );
  if (!interesting.length) {
    return `keys=${parts.length}; auth-names-in-document.cookie=(none — NID_AUT is HttpOnly)`;
  }
  return interesting
    .map((p) => {
      const [k, ...rest] = p.split("=");
      return `${k}=${maskCookie(rest.join("="))}`;
    })
    .join("; ");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
