/**
 * Analyze like_session_probe.json + like_evidence.json after verify.
 * Evidence-only — no guesses beyond what files contain.
 */

import fs from "node:fs";
import path from "node:path";

type ProbeAuth = {
  NID_AUT?: { present?: boolean };
  NID_SES?: { present?: boolean };
};

type LikeApiRequest = {
  url?: string;
  cookieHeaderPresent?: boolean;
  cookieHeaderHasNID_AUT?: boolean;
  cookieHeaderHasNID_SES?: boolean;
  cookieHeaderMasked?: string;
  origin?: string;
  referer?: string;
  frame?: { url?: string; origin?: string | null; name?: string } | null;
};

type LikeApiResponse = {
  httpStatus?: number;
  embeddedStatusCode?: number | null;
  errorCode?: number | null;
  message?: string | null;
  responseBody?: string;
};

type ProbeFile = {
  auth?: ProbeAuth;
  likeApiRequest?: LikeApiRequest;
  likeApiResponse?: LikeApiResponse;
  frames?: Array<{ url?: string; origin?: string | null; name?: string }>;
  pageUrl?: string;
};

type EvidenceFile = {
  networkHits?: Array<{
    phase?: string;
    url?: string;
    status?: number;
    responseBody?: string;
  }>;
  dialogs?: string[];
  pageUrl?: string;
};

function debugDir(): string {
  return path.join(process.cwd(), ".data", "debug", "sympathy");
}

function readJson<T>(
  file: string,
): { ok: true; data: T } | { ok: false; error: string } {
  if (!fs.existsSync(file)) return { ok: false, error: `파일 없음: ${file}` };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, "utf8")) as T };
  } catch (err) {
    return {
      ok: false,
      error: `파싱 실패: ${file} (${err instanceof Error ? err.message : err})`,
    };
  }
}

function yn(v: boolean | undefined | null, unknownLabel = "로그부족"): string {
  if (v === true) return "있음";
  if (v === false) return "없음";
  return unknownLabel;
}

function cookieHeaderLabel(req: LikeApiRequest | undefined): string {
  if (!req) return "로그부족 (likeApiRequest 없음)";
  if (req.cookieHeaderPresent === true) {
    const aut = req.cookieHeaderHasNID_AUT ? "NID_AUT포함" : "NID_AUT미포함";
    const ses = req.cookieHeaderHasNID_SES ? "NID_SES포함" : "NID_SES미포함";
    return `정상 (${aut}, ${ses})`;
  }
  if (req.cookieHeaderPresent === false) return "없음";
  return "로그부족";
}

/**
 * Print SESSION ANALYSIS block. Returns true if enough data for a firm conclusion.
 */
export function printLikeSessionAnalysis(): {
  complete: boolean;
  missing: string[];
} {
  const probePath = path.join(debugDir(), "like_session_probe.json");
  const evidencePath = path.join(debugDir(), "like_evidence.json");

  const probeRes = readJson<ProbeFile>(probePath);
  const evidenceRes = readJson<EvidenceFile>(evidencePath);

  const missing: string[] = [];
  if (!probeRes.ok) missing.push(probeRes.error);
  if (!evidenceRes.ok) missing.push(evidenceRes.error);

  const probe = probeRes.ok ? probeRes.data : null;
  const evidence = evidenceRes.ok ? evidenceRes.data : null;

  if (!probe?.auth) {
    missing.push(
      "like_session_probe.json 에 auth(NID_AUT/NID_SES) 없음 — session probe 미실행",
    );
  }
  if (!probe?.likeApiRequest) {
    missing.push(
      "like_session_probe.json 에 likeApiRequest 없음 — Cookie/Origin/Referer/Frame 판정 불가",
    );
  }
  if (
    !probe?.likeApiResponse &&
    !evidence?.networkHits?.some((h) => h.phase === "response")
  ) {
    missing.push("좋아요 API responseBody 로그 없음");
  }

  const nidAut = probe?.auth?.NID_AUT?.present;
  const nidSes = probe?.auth?.NID_SES?.present;
  const req = probe?.likeApiRequest;
  const res = probe?.likeApiResponse;

  // Fallback URL/body from evidence if probe response missing
  const evidenceResp = evidence?.networkHits?.find(
    (h) => h.phase === "response",
  );
  const likeUrl =
    req?.url ??
    evidence?.networkHits?.find((h) => h.phase === "request")?.url ??
    evidenceResp?.url ??
    "(로그부족)";

  const responseBody =
    res?.responseBody ?? evidenceResp?.responseBody ?? "(로그부족)";
  const embedded =
    res?.embeddedStatusCode ??
    (() => {
      const m = String(responseBody).match(/"statusCode"\s*:\s*(\d+)/);
      return m ? Number(m[1]) : null;
    })();
  const httpStatus = res?.httpStatus ?? evidenceResp?.status ?? null;
  const message =
    res?.message ??
    (() => {
      const m = String(responseBody).match(/"message"\s*:\s*"([^"]*)"/);
      return m?.[1] ?? null;
    })();

  const frameLine = req?.frame
    ? `name=${req.frame.name ?? "?"} origin=${req.frame.origin ?? "?"} url=${req.frame.url ?? "?"}`
    : probe?.frames?.[0]
      ? `(pre-click frames only) name=${probe.frames[0].name} origin=${probe.frames[0].origin} url=${probe.frames[0].url}`
      : "(로그부족)";

  const origin = req?.origin ?? "(로그부족)";
  const referer = req?.referer ?? "(로그부족)";

  // Conclusion only when we have enough fields
  let finalCause = "(로그 부족 — 결론 보류)";
  let nextFile = "(보류)";
  let nextFn = "(보류)";
  let basis = "";

  const hasAuthCookies = nidAut === true && nidSes === true;
  const noAuthCookies = nidAut === false && nidSes === false;
  const cookieHeaderOk = req?.cookieHeaderPresent === true;
  const cookieHeaderMissing = req?.cookieHeaderPresent === false;
  const is401 =
    embedded === 401 ||
    /로그인 하신 후/.test(String(responseBody)) ||
    /로그인 하신 후/.test(String(message ?? ""));

  if (missing.some((m) => m.includes("likeApiRequest") || m.includes("auth"))) {
    finalCause =
      "분석에 필요한 session probe 파일이 없거나 불완전함 — verify를 다시 실행해 like_session_probe.json 을 생성해야 함";
    nextFile = "(재실행 후 판정)";
    nextFn = "(재실행 후 판정)";
    basis = missing.join(" | ");
  } else if (noAuthCookies && is401) {
    finalCause =
      "Context에 NID_AUT/NID_SES가 없어 좋아요 API가 비로그인으로 401을 반환함";
    nextFile = "src/adapters/naver/login.ts";
    nextFn = "ensureNaverLogin / detectLoggedIn (쿠키 기반 로그인 세션 확보)";
    basis =
      "probe.auth NID_AUT/NID_SES present=false 이고 responseBody statusCode=401 message=로그인 필요";
  } else if (hasAuthCookies && cookieHeaderMissing && is401) {
    finalCause =
      "Context에는 로그인 쿠키가 있으나 좋아요 요청 Cookie 헤더에 실리지 않아 API가 비로그인으로 401을 반환함";
    nextFile = "src/adapters/browser/BrowserSessionManager.ts";
    nextFn = "getContext / cookie domain·SameSite 설정 (apis.naver.com 전송)";
    basis =
      "auth present=true 인데 likeApiRequest.cookieHeaderPresent=false 이고 statusCode=401";
  } else if (
    hasAuthCookies &&
    cookieHeaderOk &&
    req?.cookieHeaderHasNID_AUT === false &&
    is401
  ) {
    finalCause =
      "Cookie 헤더는 있으나 NID_AUT가 포함되지 않아 좋아요 API가 비로그인으로 401을 반환함";
    nextFile = "src/adapters/browser/BrowserSessionManager.ts";
    nextFn = "restoreCookies / cookie domain 필터 (NID_AUT → apis.naver.com)";
    basis =
      "cookieHeaderPresent=true, cookieHeaderHasNID_AUT=false, statusCode=401";
  } else if (
    hasAuthCookies &&
    cookieHeaderOk &&
    req?.cookieHeaderHasNID_AUT &&
    is401
  ) {
    finalCause =
      "로그인 쿠키가 요청에 포함됐는데도 401 — 쿠키 만료/무효 또는 guestToken·세션 불일치";
    nextFile = "src/adapters/naver/login.ts";
    nextFn = "ensureNaverLogin (유효 세션 재발급 / 만료 쿠키 갱신)";
    basis =
      "NID_AUT/NID_SES 존재 + Cookie 헤더에 NID_AUT 포함 + responseBody statusCode=401";
  } else if (is401) {
    finalCause =
      "좋아요 API가 로그인 필요로 401을 반환함 (쿠키/헤더 세부 조건은 로그 보강 필요)";
    nextFile = "src/adapters/naver/login.ts";
    nextFn = "ensureNaverLogin";
    basis = `embeddedStatusCode=${embedded} message=${message ?? "(n/a)"}`;
  } else if (embedded === 200 || (httpStatus === 200 && !is401)) {
    finalCause =
      "좋아요 API는 성공 응답 — 세션 401 문제는 이 실행에서 재현되지 않음";
    nextFile = "(해당 없음)";
    nextFn = "(해당 없음)";
    basis = `httpStatus=${httpStatus} embeddedStatusCode=${embedded}`;
  }

  console.log(`
==========================
SESSION ANALYSIS
==========================

NID_AUT : ${yn(nidAut)}
NID_SES : ${yn(nidSes)}

Cookie Header : ${cookieHeaderLabel(req)}

Like Request URL :
${likeUrl}

Origin :
${origin}

Referer :
${referer}

Frame :
${frameLine}

Response Status :
HTTP=${httpStatus ?? "(로그부족)"} / embedded statusCode=${embedded ?? "(로그부족)"} / errorCode=${res?.errorCode ?? "(n/a)"} / message=${message ?? "(n/a)"}

Response Body :
${String(responseBody).slice(0, 1500)}

최종 원인 :
${finalCause}

다음 수정해야 할 파일 :
${nextFile}

다음 수정해야 할 함수 :
${nextFn}

근거 :
${basis || "(파일 필드 기준)"}
`);

  if (missing.length) {
    console.log("부족한 로그:");
    for (const m of missing) console.log(`  - ${m}`);
    console.log("");
  }

  return { complete: missing.length === 0, missing };
}

/** CLI: node --import tsx scripts/analyze-like-session.ts */
export function mainAnalyzeLikeSession(): void {
  const { complete } = printLikeSessionAnalysis();
  if (!complete) process.exitCode = 2;
}
