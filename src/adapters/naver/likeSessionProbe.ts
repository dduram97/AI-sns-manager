/**
 * Like API session probe — cookies / Origin / Referer / frame.
 * Does NOT change click logic. Investigation only.
 */

import fs from "node:fs";
import path from "node:path";
import type { Cookie, Page, Request, Response } from "playwright";

const LIKE_API_RE =
  /apis\.naver\.com\/.*like|blogserver\/like|likeit|sympathy|reaction|feedback/i;

function probeJsonPath(): string {
  return path.join(
    process.cwd(),
    ".data",
    "debug",
    "sympathy",
    "like_session_probe.json",
  );
}

/** Absolute path for logs / verify existsSync checks */
export function getLikeSessionProbePath(): string {
  return path.resolve(probeJsonPath());
}

function readProbeJson(): Record<string, unknown> {
  const p = probeJsonPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Merge-patch write for like_session_probe.json.
 * Always logs WRITE START / END and absolute path.
 */
export function writeProbeJson(patch: Record<string, unknown>): void {
  const p = getLikeSessionProbePath();
  console.log(`[session-probe] WRITE START path=${p}`);
  console.log(`[session-probe] WRITE START cwd=${process.cwd()}`);
  console.log(
    `[session-probe] WRITE START patchKeys=${Object.keys(patch).join(",")}`,
  );
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const cur = readProbeJson();
    const next = {
      ...cur,
      ...patch,
      updatedAt: new Date().toISOString(),
      _writeMeta: {
        cwd: process.cwd(),
        absPath: p,
        pid: process.pid,
      },
    };
    const body = JSON.stringify(next, null, 2);
    fs.writeFileSync(p, body, "utf8");
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : -1;
    console.log(
      `[session-probe] WRITE END ok exists=${exists} size=${size} path=${p}`,
    );
    if (!exists) {
      console.error(
        `[session-probe] WRITE END ERROR: writeFileSync returned but existsSync=false path=${p}`,
      );
    }
  } catch (err) {
    console.error(
      `[session-probe] WRITE END EXCEPTION path=${p} err=${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    throw err;
  }
}

/** Canary write that needs no Playwright page — proves disk path works. */
export function writeSessionProbeCanary(reason: string): string {
  const p = getLikeSessionProbePath();
  writeProbeJson({
    canary: {
      reason,
      at: new Date().toISOString(),
    },
  });
  return p;
}

function maskCookieHeader(raw: string): string {
  if (!raw || raw.startsWith("(MISSING")) return raw;
  return raw.replace(
    /(NID_AUT|NID_SES|NID_JKL)=([^;]*)/gi,
    (_m, name: string, val: string) => `${name}=${maskCookieValue(name, val)}`,
  );
}

function maskCookieValue(name: string, value: string): string {
  // Keep enough to compare presence/prefix; avoid dumping full auth secrets to logs if huge
  if (!value) return "";
  if (name === "NID_AUT" || name === "NID_SES" || name === "NID_JKL") {
    if (value.length <= 12) return value;
    return `${value.slice(0, 6)}…${value.slice(-4)}(len=${value.length})`;
  }
  if (value.length > 80) return `${value.slice(0, 40)}…(len=${value.length})`;
  return value;
}

function cookieJarPath(): string {
  return (
    process.env.BROWSER_COOKIE_PATH ??
    path.join(process.cwd(), ".data", "browser", "naver-cookies.json")
  );
}

function summarizeCookies(cookies: Cookie[]) {
  return cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    valueMasked: maskCookieValue(c.name, c.value),
    valueLen: c.value?.length ?? 0,
  }));
}

function findAuth(cookies: Cookie[]) {
  const aut = cookies.filter((c) => c.name === "NID_AUT");
  const ses = cookies.filter((c) => c.name === "NID_SES");
  return {
    NID_AUT: {
      present: aut.length > 0,
      count: aut.length,
      domains: aut.map((c) => c.domain),
      valueLens: aut.map((c) => c.value?.length ?? 0),
      masked: aut.map((c) => maskCookieValue(c.name, c.value)),
    },
    NID_SES: {
      present: ses.length > 0,
      count: ses.length,
      domains: ses.map((c) => c.domain),
      valueLens: ses.map((c) => c.value?.length ?? 0),
      masked: ses.map((c) => maskCookieValue(c.name, c.value)),
    },
  };
}

function loadStoredCookies(): Cookie[] {
  const p = cookieJarPath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Cookie[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function compareCookieSets(
  labelA: string,
  a: Cookie[],
  labelB: string,
  b: Cookie[],
) {
  const key = (c: Cookie) => `${c.name}|${c.domain}|${c.path}`;
  const mapA = new Map(a.map((c) => [key(c), c]));
  const mapB = new Map(b.map((c) => [key(c), c]));
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const valueDiff: string[] = [];
  for (const [k, ca] of mapA) {
    const cb = mapB.get(k);
    if (!cb) onlyA.push(k);
    else if (ca.value !== cb.value) {
      valueDiff.push(
        `${k} ${labelA}Len=${ca.value?.length ?? 0} ${labelB}Len=${cb.value?.length ?? 0}`,
      );
    }
  }
  for (const k of mapB.keys()) {
    if (!mapA.has(k)) onlyB.push(k);
  }
  return { onlyA, onlyB, valueDiff };
}

async function dumpFrames(page: Page) {
  const frames = page.frames();
  const out: Array<{
    name: string;
    url: string;
    origin: string | null;
    parent: string | null;
  }> = [];
  for (const f of frames) {
    let origin: string | null = null;
    try {
      origin = await f.evaluate(`(() => {
        try { return location.origin; } catch (e) { return null; }
      })()`);
    } catch {
      origin = null;
    }
    out.push({
      name: f.name() || "(main/unnamed)",
      url: f.url(),
      origin,
      parent: f.parentFrame()?.url() ?? null,
    });
  }
  return out;
}

/**
 * Dump context cookies + storageState jar comparison (points 1,2,8,9 frames).
 */
export async function dumpSessionBeforeLike(page: Page): Promise<{
  contextCookies: Cookie[];
  auth: ReturnType<typeof findAuth>;
  frames: Awaited<ReturnType<typeof dumpFrames>>;
}> {
  console.log("[session-probe] ========== SESSION PROBE (pre-like) ==========");
  console.log(
    `[session-probe] dumpSessionBeforeLike ENTER pageUrl=${page.url()} probePath=${getLikeSessionProbePath()}`,
  );

  // Write immediately so we know this function was reached even if cookies() hangs/throws
  try {
    writeProbeJson({
      dumpEnteredAt: new Date().toISOString(),
      pageUrlAtEnter: page.url(),
    });
  } catch (err) {
    console.error(
      `[session-probe] early canary write failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  const contextCookies = await page.context().cookies();
  console.log(
    `[session-probe] 1) context.cookies() count=${contextCookies.length}`,
  );
  for (const c of summarizeCookies(contextCookies)) {
    console.log(
      `[session-probe] COOKIE name=${c.name} domain=${c.domain} path=${c.path} httpOnly=${c.httpOnly} secure=${c.secure} sameSite=${c.sameSite} expires=${c.expires} value=${c.valueMasked}`,
    );
  }

  const auth = findAuth(contextCookies);
  console.log(
    `[session-probe] 2) NID_AUT present=${auth.NID_AUT.present} count=${auth.NID_AUT.count} domains=${JSON.stringify(auth.NID_AUT.domains)} lens=${JSON.stringify(auth.NID_AUT.valueLens)} masked=${JSON.stringify(auth.NID_AUT.masked)}`,
  );
  console.log(
    `[session-probe] 2) NID_SES present=${auth.NID_SES.present} count=${auth.NID_SES.count} domains=${JSON.stringify(auth.NID_SES.domains)} lens=${JSON.stringify(auth.NID_SES.valueLens)} masked=${JSON.stringify(auth.NID_SES.masked)}`,
  );

  // storageState from live context
  let storageCookies: Cookie[] = [];
  try {
    const state = await page.context().storageState();
    storageCookies = state.cookies as Cookie[];
    console.log(
      `[session-probe] 8) context.storageState().cookies count=${storageCookies.length}`,
    );
  } catch (err) {
    console.log(
      `[session-probe] 8) storageState() failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  const jar = loadStoredCookies();
  console.log(
    `[session-probe] 8) cookie jar file=${cookieJarPath()} count=${jar.length}`,
  );

  const vsStorage = compareCookieSets(
    "context",
    contextCookies,
    "storageState",
    storageCookies,
  );
  console.log(
    `[session-probe] 8) context vs storageState onlyInContext=${vsStorage.onlyA.length} onlyInStorage=${vsStorage.onlyB.length} valueDiff=${vsStorage.valueDiff.length}`,
  );
  if (vsStorage.onlyA.length) {
    console.log(
      `[session-probe] 8) onlyInContext sample=${JSON.stringify(vsStorage.onlyA.slice(0, 20))}`,
    );
  }
  if (vsStorage.onlyB.length) {
    console.log(
      `[session-probe] 8) onlyInStorage sample=${JSON.stringify(vsStorage.onlyB.slice(0, 20))}`,
    );
  }
  if (vsStorage.valueDiff.length) {
    console.log(
      `[session-probe] 8) valueDiff sample=${JSON.stringify(vsStorage.valueDiff.slice(0, 20))}`,
    );
  }

  const vsJar = compareCookieSets("context", contextCookies, "jarFile", jar);
  console.log(
    `[session-probe] 8) context vs jarFile onlyInContext=${vsJar.onlyA.length} onlyInJar=${vsJar.onlyB.length} valueDiff=${vsJar.valueDiff.length}`,
  );
  if (vsJar.valueDiff.length) {
    console.log(
      `[session-probe] 8) jar valueDiff sample=${JSON.stringify(vsJar.valueDiff.slice(0, 20))}`,
    );
  }
  // Auth-focused jar compare
  const jarAuth = findAuth(jar);
  console.log(
    `[session-probe] 8) jar NID_AUT=${jarAuth.NID_AUT.present} NID_SES=${jarAuth.NID_SES.present}`,
  );

  const frames = await dumpFrames(page);
  console.log(`[session-probe] 9) page.frames() count=${frames.length}`);
  for (const f of frames) {
    console.log(
      `[session-probe] 9) frame name=${f.name} origin=${f.origin} url=${f.url} parent=${f.parent}`,
    );
  }

  // Persist probe snapshot
  try {
    writeProbeJson({
      at: new Date().toISOString(),
      pageUrl: page.url(),
      auth,
      jarAuth,
      contextCookies: summarizeCookies(contextCookies),
      storageCookies: summarizeCookies(storageCookies),
      jarCookies: summarizeCookies(jar),
      compare: { vsStorage, vsJar },
      frames,
    });
    console.log(`[session-probe] wrote ${probeJsonPath()}`);
  } catch (err) {
    console.warn("[session-probe] write failed", err);
  }

  return { contextCookies, auth, frames };
}

/**
 * Log points 3–7, 9–10 for a like API request/response.
 * Call from request/response listeners (no click changes).
 */
export async function logLikeApiRequestSession(
  req: Request,
  contextCookies: Cookie[],
): Promise<void> {
  const url = req.url();
  if (!LIKE_API_RE.test(url)) return;

  console.log("[session-probe] ---------- LIKE API REQUEST ----------");
  console.log(`[session-probe] 4) like request URL=${url}`);

  let headers: Record<string, string> = {};
  try {
    headers = await req.allHeaders();
  } catch {
    headers = req.headers();
  }

  const cookieHeader =
    headers.cookie ??
    headers.Cookie ??
    "(MISSING — Cookie header not visible / not sent)";
  console.log(`[session-probe] 3) Cookie header=${cookieHeader}`);

  // Which auth cookies appear in the Cookie header string
  const hasAutInHeader = /(?:^|;\s*)NID_AUT=/.test(cookieHeader);
  const hasSesInHeader = /(?:^|;\s*)NID_SES=/.test(cookieHeader);
  console.log(
    `[session-probe] 3) Cookie header has NID_AUT=${hasAutInHeader} NID_SES=${hasSesInHeader}`,
  );

  // Context cookies that SHOULD apply to apis.naver.com
  const forApis = contextCookies.filter((c) => {
    const d = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
    return (
      "apis.naver.com".endsWith(d) ||
      d === "naver.com" ||
      d.endsWith(".naver.com")
    );
  });
  console.log(
    `[session-probe] 3) context cookies applicable to apis.naver.com count=${forApis.length} names=${JSON.stringify(forApis.map((c) => `${c.name}@${c.domain}`))}`,
  );

  const origin = headers.origin ?? headers.Origin ?? "(none)";
  const referer = headers.referer ?? headers.Referer ?? "(none)";
  console.log(`[session-probe] 5) Origin=${origin}`);
  console.log(`[session-probe] 6) Referer=${referer}`);

  // Dump other interesting request headers
  for (const key of [
    "user-agent",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "accept",
    "content-type",
  ]) {
    if (headers[key])
      console.log(`[session-probe] REQ header ${key}=${headers[key]}`);
  }

  // Frame that initiated the request
  let frameInfo: {
    url: string;
    origin: string | null;
    name: string;
  } | null = null;
  try {
    const frame = req.frame();
    let frameOrigin: string | null = null;
    try {
      frameOrigin = await frame.evaluate(`(() => {
        try { return location.origin; } catch (e) { return null; }
      })()`);
    } catch {
      frameOrigin = null;
    }
    frameInfo = {
      url: frame.url(),
      origin: frameOrigin,
      name: frame.name() || "(main)",
    };
    console.log(
      `[session-probe] 9) like API executed from frame url=${frameInfo.url} origin=${frameInfo.origin} name=${frameInfo.name}`,
    );
  } catch (err) {
    console.log(
      `[session-probe] 9) frame resolve failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  const cookieMissing =
    !cookieHeader ||
    cookieHeader.startsWith("(MISSING") ||
    cookieHeader === "(none)";
  writeProbeJson({
    likeApiRequest: {
      at: new Date().toISOString(),
      url,
      method: req.method(),
      resourceType: req.resourceType(),
      cookieHeaderPresent: !cookieMissing,
      cookieHeaderHasNID_AUT: hasAutInHeader,
      cookieHeaderHasNID_SES: hasSesInHeader,
      cookieHeaderMasked: maskCookieHeader(cookieHeader),
      cookieHeaderLen: cookieMissing ? 0 : cookieHeader.length,
      applicableCookieNames: forApis.map((c) => `${c.name}@${c.domain}`),
      origin,
      referer,
      frame: frameInfo,
      requestHeadersSample: {
        "user-agent": headers["user-agent"] ?? null,
        "sec-fetch-site": headers["sec-fetch-site"] ?? null,
        "sec-fetch-mode": headers["sec-fetch-mode"] ?? null,
        "sec-fetch-dest": headers["sec-fetch-dest"] ?? null,
      },
    },
  });
}

export async function logLikeApiResponseSession(res: Response): Promise<{
  status: number;
  body: string;
  headers: Record<string, string>;
} | null> {
  const url = res.url();
  if (!LIKE_API_RE.test(url)) return null;

  console.log("[session-probe] ---------- LIKE API RESPONSE ----------");
  console.log(`[session-probe] 4) response URL=${url}`);

  const headers = res.headers();
  console.log(`[session-probe] 7) Response headers=${JSON.stringify(headers)}`);

  let body = "";
  try {
    body = (await res.text()).slice(0, 8000);
  } catch (err) {
    body = `(read-failed: ${err instanceof Error ? err.message : err})`;
  }

  // Extract statusCode from JSONP if present
  let embeddedStatus: string | null = null;
  const m = body.match(/"statusCode"\s*:\s*(\d+)/);
  if (m) embeddedStatus = m[1];
  const msg = body.match(/"message"\s*:\s*"([^"]*)"/);
  const errCode = body.match(/"errorCode"\s*:\s*(\d+)/);

  console.log(`[session-probe] 10) HTTP status=${res.status()}`);
  console.log(
    `[session-probe] 10) embedded statusCode=${embeddedStatus ?? "(n/a)"} errorCode=${errCode?.[1] ?? "(n/a)"} message=${msg?.[1] ?? "(n/a)"}`,
  );
  console.log(`[session-probe] 10) responseBody=${body}`);

  writeProbeJson({
    likeApiResponse: {
      at: new Date().toISOString(),
      url,
      httpStatus: res.status(),
      embeddedStatusCode: embeddedStatus ? Number(embeddedStatus) : null,
      errorCode: errCode?.[1] ? Number(errCode[1]) : null,
      message: msg?.[1] ?? null,
      responseBody: body,
      responseHeaders: headers,
    },
  });

  return { status: res.status(), body, headers };
}
