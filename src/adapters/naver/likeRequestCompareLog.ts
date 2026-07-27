/**
 * Like API request compare log (Playwright side).
 * For 1:1 comparison with Chrome DevTools Network.
 * Does NOT change like-click logic.
 */

import fs from "node:fs";
import path from "node:path";
import type { Page, Request, Response } from "playwright";

const LIKE_API_RE =
  /apis\.naver\.com\/.*like|blogserver\/like|blog\.like\.naver\.com/i;

function outPath(): string {
  const dir = path.join(process.cwd(), ".data", "debug", "sympathy");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "like_request_compare_playwright.json");
}

export function getLikeRequestComparePath(): string {
  return path.resolve(outPath());
}

function maskCookieHeader(cookie: string | undefined): string | undefined {
  if (!cookie) return cookie;
  return cookie
    .split(";")
    .map((part) => {
      const [k, ...rest] = part.trim().split("=");
      const v = rest.join("=");
      if (!k) return part;
      if (/^(NID_AUT|NID_SES|NID_JKL|NID_JST|BUC|PM_CK_loc)$/i.test(k)) {
        if (v.length <= 12) return `${k}=${v}(len=${v.length})`;
        return `${k}=${v.slice(0, 6)}…${v.slice(-4)}(len=${v.length})`;
      }
      return `${k}=${v}`;
    })
    .join("; ");
}

/** Snapshot navigator / chrome environment for DevTools-side compare. */
export async function captureLikeCompareNavigator(
  page: Page,
): Promise<Record<string, unknown>> {
  const src = `(() => {
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
    var chromeObj = null;
    try {
      chromeObj = typeof window.chrome === 'undefined'
        ? { exists: false }
        : { exists: true, keys: Object.keys(window.chrome || {}).slice(0, 20) };
    } catch (e2) {
      chromeObj = { exists: 'error', error: String(e2) };
    }
    var navTiming = null;
    try {
      var entries = performance.getEntriesByType('navigation');
      if (entries && entries[0]) {
        var n = entries[0];
        navTiming = {
          type: n.type,
          nextHopProtocol: n.nextHopProtocol,
          transferSize: n.transferSize,
          encodedBodySize: n.encodedBodySize,
          decodedBodySize: n.decodedBodySize,
          domContentLoadedEventEnd: n.domContentLoadedEventEnd,
          loadEventEnd: n.loadEventEnd,
          startTime: n.startTime
        };
      } else if (performance.navigation) {
        navTiming = {
          legacyType: performance.navigation.type,
          legacyRedirectCount: performance.navigation.redirectCount
        };
      }
    } catch (e3) {
      navTiming = { error: String(e3) };
    }
    return {
      userAgent: navigator.userAgent,
      userAgentData: uad,
      language: navigator.language,
      languages: navigator.languages ? Array.from(navigator.languages) : [],
      platform: navigator.platform,
      vendor: navigator.vendor,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      webdriver: navigator.webdriver,
      cookieEnabled: navigator.cookieEnabled,
      windowChrome: chromeObj,
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      performanceNavigation: navTiming,
      locationHref: location.href,
      documentReadyState: document.readyState
    };
  })()`;
  try {
    return (await page.evaluate(src)) as Record<string, unknown>;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

type CompareDoc = {
  source: "playwright";
  purpose: string;
  at: string;
  pageUrl: string;
  navigator: Record<string, unknown> | null;
  likeApiRequests: Array<Record<string, unknown>>;
  humanCompareHint: string;
};

function readDoc(): CompareDoc {
  const p = outPath();
  if (!fs.existsSync(p)) {
    return {
      source: "playwright",
      purpose:
        "1:1 compare with Chrome DevTools Network (copy same fields into like_request_compare_human.json)",
      at: new Date().toISOString(),
      pageUrl: "",
      navigator: null,
      likeApiRequests: [],
      humanCompareHint:
        "In Chrome DevTools → Network → like/v1 request → Headers/Payload/Response Headers. Mirror this schema under source=human.",
    };
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as CompareDoc;
  } catch {
    return {
      source: "playwright",
      purpose: "1:1 compare with Chrome DevTools Network",
      at: new Date().toISOString(),
      pageUrl: "",
      navigator: null,
      likeApiRequests: [],
      humanCompareHint: "",
    };
  }
}

function writeDoc(doc: CompareDoc): void {
  const p = outPath();
  fs.writeFileSync(p, JSON.stringify(doc, null, 2), "utf8");
  console.log(`[like-compare] wrote ${p}`);
}

export async function initLikeRequestCompareLog(page: Page): Promise<void> {
  const nav = await captureLikeCompareNavigator(page);
  const doc: CompareDoc = {
    source: "playwright",
    purpose:
      "1:1 compare with Chrome DevTools Network (save human capture as like_request_compare_human.json)",
    at: new Date().toISOString(),
    pageUrl: page.url(),
    navigator: nav,
    likeApiRequests: [],
    humanCompareHint:
      "Chrome DevTools: Network → filter like → click request → copy Request URL, Method, Request Headers, Response Headers, Protocol (h2/http/1.1). Put under like_request_compare_human.json with same keys.",
  };
  writeDoc(doc);
  console.log("[like-compare] ========== NAVIGATOR SNAPSHOT ==========");
  console.log(`[like-compare] userAgent=${nav.userAgent}`);
  console.log(
    `[like-compare] userAgentData=${JSON.stringify(nav.userAgentData)}`,
  );
  console.log(
    `[like-compare] language=${nav.language} languages=${JSON.stringify(nav.languages)}`,
  );
  console.log(`[like-compare] platform=${nav.platform} vendor=${nav.vendor}`);
  console.log(
    `[like-compare] hardwareConcurrency=${nav.hardwareConcurrency} deviceMemory=${nav.deviceMemory} maxTouchPoints=${nav.maxTouchPoints}`,
  );
  console.log(
    `[like-compare] window.chrome=${JSON.stringify(nav.windowChrome)}`,
  );
  console.log(`[like-compare] visibilityState=${nav.visibilityState}`);
  console.log(
    `[like-compare] performanceNavigation=${JSON.stringify(nav.performanceNavigation)}`,
  );
  console.log("[like-compare] ========================================");
}

async function cdpEnrich(
  page: Page,
  req: Request,
  res: Response | null,
): Promise<{
  httpVersion: string | null;
  tls: Record<string, unknown> | null;
  protocol: string | null;
}> {
  let httpVersion: string | null = null;
  let protocol: string | null = null;
  let tls: Record<string, unknown> | null = null;
  try {
    const session = await page.context().newCDPSession(page);
    // Best-effort: match by URL in recent responses via Runtime only is hard;
    // use response headers Timing-Allow / Playwright's built-in if any.
    try {
      // Playwright 1.40+ may expose _protocol via CDP; use Security if available
      const security = (await session
        .send("Security.enable" as "Security.enable")
        .catch(() => null)) as unknown;
      void security;
    } catch {
      // ignore
    }
    await session.detach().catch(() => undefined);
  } catch {
    // ignore
  }

  // From Playwright response / request frames (best-effort internals)
  try {
    const anyRes = res as unknown as { _protocol?: string } | null;
    const anyReq = req as unknown as { _protocol?: string };
    const p = anyRes?._protocol ?? anyReq?._protocol ?? null;
    if (typeof p === "string") protocol = p;
  } catch {
    // ignore
  }

  // Headers sometimes include :status for h2 — detect via allHeaders keys
  try {
    if (res) {
      const h = await res.allHeaders();
      if (Object.keys(h).some((k) => k.startsWith(":"))) {
        httpVersion = "h2 (pseudo-headers present)";
      }
    }
  } catch {
    // ignore
  }

  // Prefer server timing / nextHop from performance resource entry
  try {
    const url = req.url();
    const entry = await page.evaluate(
      `((u) => {
        try {
          var list = performance.getEntriesByType('resource') || [];
          for (var i = list.length - 1; i >= 0; i--) {
            var e = list[i];
            if (e.name && e.name.indexOf('blogserver/like') >= 0) {
              return {
                name: e.name.slice(0, 200),
                nextHopProtocol: e.nextHopProtocol || null,
                transferSize: e.transferSize,
                encodedBodySize: e.encodedBodySize,
                initiatorType: e.initiatorType
              };
            }
            if (u && e.name === u) {
              return {
                name: e.name.slice(0, 200),
                nextHopProtocol: e.nextHopProtocol || null,
                transferSize: e.transferSize,
                encodedBodySize: e.encodedBodySize,
                initiatorType: e.initiatorType
              };
            }
          }
          return null;
        } catch (err) {
          return { error: String(err) };
        }
      })(${JSON.stringify(url)})`,
    );
    if (entry && typeof entry === "object") {
      const e = entry as { nextHopProtocol?: string };
      if (e.nextHopProtocol) {
        protocol = e.nextHopProtocol;
        httpVersion = e.nextHopProtocol;
      }
      tls = { resourceTiming: entry };
    }
  } catch {
    // ignore
  }

  return { httpVersion, tls, protocol };
}

function pickHeaders(
  all: Record<string, string>,
): Record<string, string | undefined> {
  const lower = Object.fromEntries(
    Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const get = (...names: string[]) => {
    for (const n of names) {
      if (lower[n.toLowerCase()] != null) return lower[n.toLowerCase()];
    }
    return undefined;
  };
  return {
    cookie: maskCookieHeader(get("cookie")),
    "user-agent": get("user-agent"),
    accept: get("accept"),
    "accept-language": get("accept-language"),
    referer: get("referer"),
    origin: get("origin"),
    "sec-fetch-site": get("sec-fetch-site"),
    "sec-fetch-mode": get("sec-fetch-mode"),
    "sec-fetch-dest": get("sec-fetch-dest"),
    "sec-fetch-user": get("sec-fetch-user"),
    "sec-ch-ua": get("sec-ch-ua"),
    "sec-ch-ua-mobile": get("sec-ch-ua-mobile"),
    "sec-ch-ua-platform": get("sec-ch-ua-platform"),
    priority: get("priority"),
    // keep full map too
  };
}

/**
 * Log Like API request+response into compare JSON.
 * Call from evidence listeners only — does not change click.
 */
export async function logLikeApiForCompare(
  page: Page,
  req: Request,
  res?: Response | null,
): Promise<void> {
  const url = req.url();
  if (!LIKE_API_RE.test(url)) return;

  let requestHeadersAll: Record<string, string> = {};
  try {
    requestHeadersAll = await req.allHeaders();
  } catch {
    try {
      requestHeadersAll = req.headers();
    } catch {
      requestHeadersAll = {};
    }
  }

  let responseHeadersAll: Record<string, string> = {};
  let status: number | null = null;
  let statusText: string | null = null;
  let responseBody: string | null = null;
  if (res) {
    status = res.status();
    statusText = res.statusText();
    try {
      responseHeadersAll = await res.allHeaders();
    } catch {
      try {
        responseHeadersAll = res.headers();
      } catch {
        responseHeadersAll = {};
      }
    }
    try {
      responseBody = (await res.text()).slice(0, 4000);
    } catch {
      responseBody = null;
    }
  }

  const enrich = await cdpEnrich(page, req, res ?? null);
  const highlighted = pickHeaders(requestHeadersAll);

  // Mask cookie in full headers copy
  const requestHeadersMasked: Record<string, string> = { ...requestHeadersAll };
  for (const k of Object.keys(requestHeadersMasked)) {
    if (k.toLowerCase() === "cookie") {
      requestHeadersMasked[k] =
        maskCookieHeader(requestHeadersMasked[k]) ?? requestHeadersMasked[k];
    }
  }

  const entry = {
    at: new Date().toISOString(),
    requestUrl: url,
    httpMethod: req.method(),
    resourceType: req.resourceType(),
    requestHeadersHighlighted: highlighted,
    requestHeadersAll: requestHeadersMasked,
    responseStatus: status,
    responseStatusText: statusText,
    responseHeadersAll,
    responseBodyPreview: responseBody,
    httpVersion: enrich.httpVersion,
    protocol: enrich.protocol,
    tls: enrich.tls,
    frame: {
      url: req.frame().url(),
      name: req.frame().name() || "(main)",
    },
  };

  console.log("[like-compare] ========== LIKE API REQUEST ==========");
  console.log(`[like-compare] URL=${url}`);
  console.log(`[like-compare] Method=${req.method()}`);
  console.log(
    `[like-compare] Headers(highlighted)=${JSON.stringify(highlighted, null, 2)}`,
  );
  console.log(
    `[like-compare] httpVersion/protocol=${enrich.httpVersion ?? enrich.protocol}`,
  );
  if (res) {
    console.log(`[like-compare] Response status=${status} ${statusText}`);
    console.log(
      `[like-compare] Response headers=${JSON.stringify(responseHeadersAll).slice(0, 800)}`,
    );
  }
  console.log("[like-compare] ======================================");

  const doc = readDoc();
  doc.at = new Date().toISOString();
  doc.pageUrl = page.url();
  doc.likeApiRequests = [...(doc.likeApiRequests ?? []), entry].slice(-10);
  writeDoc(doc);
}

export function isLikeApiCompareUrl(url: string): boolean {
  return LIKE_API_RE.test(url);
}
