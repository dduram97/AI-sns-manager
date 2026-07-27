/**
 * Like-click evidence collector (no speculative fixes).
 * Goal: prove why Naver ignores / rejects the like after click.
 *
 * Enable: NAVER_LIKE_DEBUG=1 (or SYMPATHY_DEBUG / NAVER_ADAPTER_DEBUG)
 */

import fs from "node:fs";
import path from "node:path";
import type {
  Cookie,
  Locator,
  Page,
  Request,
  Response,
  Dialog,
  ConsoleMessage,
} from "playwright";
import {
  dumpSessionBeforeLike,
  logLikeApiRequestSession,
  logLikeApiResponseSession,
  writeSessionProbeCanary,
  getLikeSessionProbePath,
} from "./likeSessionProbe";
import {
  initLikeRequestCompareLog,
  logLikeApiForCompare,
  isLikeApiCompareUrl,
  getLikeRequestComparePath,
} from "./likeRequestCompareLog";
import {
  installLikeItInternalsHooks,
  snapshotLikeItState,
  finishLikeItInternalsTrace,
  printEvidenceBasedLikeItFlow,
} from "./likeItInternalsTrace";
import { traceEnter, traceReturn } from "./traceSummary";

export function isLikeDebugEnabled(): boolean {
  if (process.env.NAVER_LIKE_DEBUG === "0") return false;
  if (
    process.env.NAVER_LIKE_DEBUG === "1" ||
    process.env.SYMPATHY_DEBUG === "1" ||
    process.env.NAVER_ADAPTER_DEBUG === "1"
  ) {
    return true;
  }
  // Headful Live diagnose: collect evidence without requiring env each time
  return (
    process.env.BROWSER_HEADLESS === "false" ||
    process.env.BROWSER_HEADLESS === "0"
  );
}

export function likeDebugHoldMs(): number {
  const n = Number(process.env.NAVER_LIKE_DEBUG_HOLD_MS ?? 10_000);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

const LIKE_URL_RE = /like|reaction|sympathy|feedback|likeit/i;

function debugDir(): string {
  const dir = path.join(process.cwd(), ".data", "debug", "sympathy");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveNamedScreenshot(
  page: Page,
  filename: string,
): Promise<string | null> {
  try {
    const file = path.join(debugDir(), filename);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[like-debug] screenshot → ${file}`);
    return file;
  } catch (err) {
    console.warn(
      `[like-debug] screenshot ${filename} failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

const FACE_DOM_SOURCE = `(() => {
  var face = document.querySelector('a.u_likeit_button._face');
  if (!face) return { found: false };
  var icon = face.querySelector('span.u_likeit_icon') || face.querySelector('[class*="__reaction__"]');
  return {
    found: true,
    className: (face.getAttribute('class') || '').toString(),
    ariaPressed: face.getAttribute('aria-pressed'),
    ariaLabel: face.getAttribute('aria-label'),
    outerHTML: (face.outerHTML || '').toString().slice(0, 1200),
    iconClass: icon ? (icon.getAttribute('class') || '').toString() : null
  };
})()`;

const LAYERS_SOURCE = `(() => {
  function css(el) {
    try {
      var s = window.getComputedStyle(el);
      return { display: s.display, visibility: s.visibility, opacity: s.opacity, zIndex: s.zIndex, pointerEvents: s.pointerEvents };
    } catch (e) {
      return { display: '?', visibility: '?', opacity: '?', zIndex: '?', pointerEvents: '?' };
    }
  }
  function visible(el) {
    var s = css(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  var sel = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '.toast', '.popup', '.layer', '.modal',
    '[class*="toast"]', '[class*="popup"]', '[class*="layer"]',
    '[class*="Toast"]', '[class*="Popup"]', '[class*="Layer"]',
    '[class*="modal"]', '[class*="Modal"]',
    '[class*="alert"]', '[class*="Alert"]',
    '[class*="dimmed"]', '[class*="Dimmed"]',
    '[class*="overlay"]', '[class*="Overlay"]',
    '#_alertLayer', '.ly_alert', '.u_cbox_layer', '.se-popup'
  ].join(',');
  var nodes = Array.from(document.querySelectorAll(sel));
  var out = [];
  for (var i = 0; i < nodes.length && out.length < 20; i++) {
    var el = nodes[i];
    var st = css(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      className: (el.getAttribute('class') || '').toString().slice(0, 160),
      role: el.getAttribute('role'),
      visible: visible(el),
      display: st.display,
      visibility: st.visibility,
      opacity: st.opacity,
      zIndex: st.zIndex,
      pointerEvents: st.pointerEvents,
      innerText: ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 400),
      outerHTML: (el.outerHTML || '').toString().slice(0, 800)
    });
  }
  return out;
})()`;

const ACTIVE_EL_SOURCE = `(() => {
  var el = document.activeElement;
  if (!el) return { tag: null };
  return {
    tag: el.tagName ? el.tagName.toLowerCase() : null,
    id: el.id || null,
    className: (el.getAttribute && el.getAttribute('class') || '').toString().slice(0, 160),
    role: el.getAttribute ? el.getAttribute('role') : null,
    ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
    text: ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    outerHTML: (el.outerHTML || '').toString().slice(0, 500)
  };
})()`;

type FaceDom = {
  found: boolean;
  className?: string;
  ariaPressed?: string | null;
  ariaLabel?: string | null;
  outerHTML?: string;
  iconClass?: string | null;
};

type LayerInfo = {
  tag: string;
  className: string;
  role: string | null;
  visible: boolean;
  display: string;
  visibility: string;
  opacity: string;
  zIndex: string;
  pointerEvents: string;
  innerText: string;
  outerHTML: string;
};

type NetHit = {
  at: string;
  phase: "request" | "response";
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  requestBody?: string | null;
  responseBody?: string | null;
  headers?: Record<string, string>;
};

function logFace(label: string, face: FaceDom) {
  if (!face.found) {
    console.log(`[like-debug] DOM[${label}] face=NOT_FOUND`);
    return;
  }
  console.log(
    `[like-debug] DOM[${label}] class="${face.className}" aria-pressed=${face.ariaPressed} icon="${face.iconClass ?? ""}"`,
  );
  console.log(`[like-debug] DOM[${label}] outerHTML=${face.outerHTML}`);
}

function logLayers(label: string, layers: LayerInfo[]) {
  console.log(`[like-debug] LAYERS[${label}] count=${layers.length}`);
  if (!layers.length) {
    console.log(
      `[like-debug] LAYERS[${label}] (none matched toast/popup/layer/modal)`,
    );
    return;
  }
  for (const [i, L] of layers.entries()) {
    console.log(
      `[like-debug] LAYERS[${label}] #${i} <${L.tag}> class="${L.className}" role=${L.role} visible=${L.visible} display=${L.display} visibility=${L.visibility} opacity=${L.opacity} z=${L.zIndex} pe=${L.pointerEvents}`,
    );
    console.log(
      `[like-debug] LAYERS[${label}] #${i} innerText=${JSON.stringify(L.innerText)}`,
    );
    console.log(`[like-debug] LAYERS[${label}] #${i} outerHTML=${L.outerHTML}`);
  }
}

async function readFace(page: Page): Promise<FaceDom> {
  return (await page
    .evaluate(FACE_DOM_SOURCE)
    .catch(() => ({ found: false }))) as FaceDom;
}

async function readLayers(page: Page): Promise<LayerInfo[]> {
  return (await page.evaluate(LAYERS_SOURCE).catch(() => [])) as LayerInfo[];
}

async function readActive(page: Page): Promise<Record<string, unknown>> {
  return (await page
    .evaluate(ACTIVE_EL_SOURCE)
    .catch(() => ({ tag: null }))) as Record<string, unknown>;
}

export type LikeDebugResult = {
  verifiedOn: boolean;
  method: string;
  beforePath: string | null;
  afterPath: string | null;
  after5sPath: string | null;
  networkHits: NetHit[];
  faceBefore: FaceDom;
  faceImmediate: FaceDom;
  face1s: FaceDom;
  face5s: FaceDom;
  error?: string;
};

/**
 * Single-click evidence run:
 * - attach all listeners
 * - screenshot before
 * - one click only
 * - DOM at before / immediate / 1s / 5s
 * - layers + network bodies
 * - screenshot after + after 5s
 */
export async function runLikeClickEvidence(
  page: Page,
  clickTarget: Locator,
  opts?: { methodLabel?: string },
): Promise<LikeDebugResult> {
  traceEnter(
    "runLikeClickEvidence",
    `url=${page.url()} method=${opts?.methodLabel ?? "default"}`,
  );
  const method = opts?.methodLabel ?? "parent-face|locator.click";
  const dialogs: string[] = [];
  const consoles: string[] = [];
  const pageErrors: string[] = [];
  const allRequests: string[] = [];
  const networkHits: NetHit[] = [];
  const pendingBodies = new Map<
    string,
    { method: string; body: string | null }
  >();
  let contextCookiesSnapshot: Cookie[] = [];

  const onDialog = async (dialog: Dialog) => {
    const line = `type=${dialog.type()} message=${JSON.stringify(dialog.message())}`;
    dialogs.push(line);
    console.log(`[like-debug] DIALOG ${line}`);
    // Dismiss so automation can continue observing DOM
    try {
      await dialog.dismiss();
    } catch {
      try {
        await dialog.accept();
      } catch {
        // ignore
      }
    }
  };

  const onConsole = (msg: ConsoleMessage) => {
    const line = `${msg.type()}: ${msg.text()}`.slice(0, 500);
    consoles.push(line);
    console.log(`[like-debug] CONSOLE ${line}`);
  };

  const onPageError = (err: Error) => {
    const line = err.message;
    pageErrors.push(line);
    console.log(`[like-debug] PAGEERROR ${line}`);
  };

  const onRequest = (req: Request) => {
    const url = req.url();
    const method = req.method();
    const rt = req.resourceType();
    allRequests.push(`${method} ${rt} ${url.slice(0, 200)}`);
    if (LIKE_URL_RE.test(url)) {
      let body: string | null = null;
      try {
        body = req.postData();
      } catch {
        body = null;
      }
      pendingBodies.set(url + "|" + method, { method, body });
      const hit: NetHit = {
        at: new Date().toISOString(),
        phase: "request",
        url,
        method,
        resourceType: rt,
        requestBody: body,
      };
      networkHits.push(hit);
      console.log(`[like-debug] REQUEST likeish method=${method} type=${rt}`);
      console.log(`[like-debug] REQUEST url=${url}`);
      console.log(`[like-debug] REQUEST body=${body ?? "(none)"}`);
      // Session probe (cookies/Origin/Referer/frame) — async, fire-and-log
      void logLikeApiRequestSession(req, contextCookiesSnapshot);
    }
  };

  const onResponse = async (res: Response) => {
    const url = res.url();
    const req = res.request();
    const method = req.method();
    if (!LIKE_URL_RE.test(url)) return;
    const probed = await logLikeApiResponseSession(res);
    // Full compare snapshot (request + response) for human DevTools 1:1
    if (isLikeApiCompareUrl(url)) {
      void logLikeApiForCompare(page, req, res);
    }
    let responseBody: string | null = probed?.body ?? null;
    if (responseBody == null) {
      try {
        responseBody = (await res.text()).slice(0, 4000);
      } catch (err) {
        responseBody = `(read-failed: ${err instanceof Error ? err.message : err})`;
      }
    }
    const key = url + "|" + method;
    const pending = pendingBodies.get(key);
    const hit: NetHit = {
      at: new Date().toISOString(),
      phase: "response",
      url,
      method,
      status: probed?.status ?? res.status(),
      requestBody: pending?.body ?? req.postData() ?? null,
      responseBody,
      headers: probed?.headers ?? res.headers(),
    };
    networkHits.push(hit);
    console.log(`[like-debug] RESPONSE status=${hit.status} method=${method}`);
    console.log(`[like-debug] RESPONSE url=${url}`);
    console.log(
      `[like-debug] RESPONSE requestBody=${hit.requestBody ?? "(none)"}`,
    );
    console.log(`[like-debug] RESPONSE body=${responseBody}`);
  };

  console.log("[like-debug] ========== LIKE CLICK EVIDENCE START ==========");
  console.log(`[like-debug] method=${method} url=${page.url()}`);
  console.log(
    `[like-debug] sessionProbePath=${getLikeSessionProbePath()} debugEnabled=${isLikeDebugEnabled()} comparePath=${getLikeRequestComparePath()}`,
  );
  // Canary BEFORE any Playwright cookie work — proves evidence path reached write
  try {
    writeSessionProbeCanary("runLikeClickEvidence:enter");
  } catch (err) {
    console.error(
      `[like-debug] canary write failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  page.on("dialog", onDialog);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("request", onRequest);
  page.on("response", onResponse);

  try {
    // Session investigation BEFORE click (cookies / NID_* / frames / storageState)
    const pre = await dumpSessionBeforeLike(page);
    contextCookiesSnapshot = pre.contextCookies;

    const faceBefore = await readFace(page);
    logFace("before", faceBefore);
    const layersBefore = await readLayers(page);
    logLayers("before", layersBefore);

    const beforePath = await saveNamedScreenshot(page, "like_before.png");

    // Like API ↔ human Chrome DevTools compare snapshot (navigator + later request)
    await initLikeRequestCompareLog(page);

    // LikeIt internals: install observers BEFORE click (does not change click strategy)
    const { cdpListeners } = await installLikeItInternalsHooks(page);
    const likeItBefore = await snapshotLikeItState(page, "before-click");
    console.log(
      `[likeit-trace] snapshot before face=${JSON.stringify((likeItBefore as { face?: unknown })?.face)}`,
    );

    // One click only — no fallback spray (popups disappear too fast otherwise)
    console.log(`[like-debug] CLICK now method=${method}`);
    const netBefore = networkHits.length;
    try {
      await clickTarget
        .scrollIntoViewIfNeeded({ timeout: 8_000 })
        .catch(() => undefined);
      await clickTarget.click({ timeout: 8_000, force: true });
    } catch (err) {
      console.log(
        `[like-debug] CLICK threw: ${err instanceof Error ? err.message : err}`,
      );
    }

    const faceImmediate = await readFace(page);
    logFace("immediate", faceImmediate);
    logLayers("immediate", await readLayers(page));
    console.log(
      `[like-debug] activeElement@immediate ${JSON.stringify(await readActive(page))}`,
    );

    // User-requested: hold 5s after click so popup text is readable
    console.log("[like-debug] waiting 1000ms for DOM@1s …");
    await page.waitForTimeout(1_000);
    const face1s = await readFace(page);
    logFace("1s", face1s);
    logLayers("1s", await readLayers(page));

    console.log(
      "[like-debug] waiting remaining ~4000ms (total 5s after click) …",
    );
    await page.waitForTimeout(4_000);
    const face5s = await readFace(page);
    logFace("5s", face5s);
    logLayers("5s", await readLayers(page));
    console.log(
      `[like-debug] activeElement@5s ${JSON.stringify(await readActive(page))}`,
    );

    const afterPath = await saveNamedScreenshot(page, "like_after.png");
    const after5sPath = await saveNamedScreenshot(page, "like_after_5s.png");

    // Network summary
    const likeResponses = networkHits.filter((h) => h.phase === "response");
    const likeRequests = networkHits.filter((h) => h.phase === "request");
    if (networkHits.length === netBefore) {
      console.log("[like-debug] No network request after click");
    } else {
      console.log(
        `[like-debug] network after click: requests=${likeRequests.length - (netBefore > 0 ? 0 : 0)} hitsTotal=${networkHits.length} (since start; delta=${networkHits.length - netBefore})`,
      );
    }
    if (!likeRequests.length && !likeResponses.length) {
      console.log(
        "[like-debug] No network request after click (like/reaction/sympathy/feedback/likeit)",
      );
    }

    // Also dump recent non-like XHR/fetch count for context
    const xhrish = allRequests.filter((l) => /xhr|fetch/i.test(l));
    console.log(
      `[like-debug] all request lines captured=${allRequests.length} xhr/fetch≈${xhrish.length}`,
    );
    for (const line of allRequests.slice(-30)) {
      console.log(`[like-debug] REQ ${line}`);
    }

    console.log(
      `[like-debug] dialogs=${dialogs.length} ${JSON.stringify(dialogs)}`,
    );
    console.log(
      `[like-debug] pageErrors=${pageErrors.length} ${JSON.stringify(pageErrors)}`,
    );
    console.log(
      `[like-debug] consoleMsgs=${consoles.length} (see CONSOLE lines above)`,
    );

    // LikeIt internals timeline (success vs fail comparable)
    const likeItAfter = await snapshotLikeItState(page, "after-5s");
    await finishLikeItInternalsTrace(
      page,
      likeItBefore,
      likeItAfter,
      cdpListeners,
    );
    printEvidenceBasedLikeItFlow();

    const verifiedOn = Boolean(
      face5s.found &&
      /\bon\b/i.test(face5s.className ?? "") &&
      !/\boff\b/i.test(face5s.className ?? "") &&
      (face5s.ariaPressed === "true" ||
        /__reaction__like\b/i.test(face5s.iconClass ?? "")),
    );

    if (!verifiedOn) {
      console.log(
        `[like-debug] FAIL activeElement=${JSON.stringify(await readActive(page))}`,
      );
    }

    // Persist JSON evidence
    try {
      const jsonPath = path.join(debugDir(), "like_evidence.json");
      fs.writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            pageUrl: page.url(),
            method,
            verifiedOn,
            faceBefore,
            faceImmediate,
            face1s,
            face5s,
            networkHits,
            dialogs,
            pageErrors,
            consoles: consoles.slice(0, 100),
            screenshots: { beforePath, afterPath, after5sPath },
          },
          null,
          2,
        ),
        "utf8",
      );
      console.log(`[like-debug] evidence json → ${jsonPath}`);
    } catch (err) {
      console.warn("[like-debug] evidence json write failed", err);
    }

    console.log("[like-debug] ========== LIKE CLICK EVIDENCE END ==========");

    traceReturn(
      "runLikeClickEvidence",
      "runLikeClickEvidence_done",
      `verifiedOn=${verifiedOn}`,
    );
    return {
      verifiedOn,
      method,
      beforePath,
      afterPath,
      after5sPath,
      networkHits,
      faceBefore,
      faceImmediate,
      face1s,
      face5s,
      error: verifiedOn ? undefined : "evidence-collected-still-off",
    };
  } finally {
    page.off("dialog", onDialog);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("request", onRequest);
    page.off("response", onResponse);
  }
}

/** Keep browser open so human can read popup / network evidence. */
export async function holdBrowserForDebug(reason: string): Promise<void> {
  if (!isLikeDebugEnabled()) return;
  const ms = likeDebugHoldMs();
  console.log(
    `[like-debug] HOLD browser ${ms}ms (no auto-close yet) reason=${reason}`,
  );
  await new Promise((r) => setTimeout(r, ms));
}
