/**
 * AI comment draft generation.
 * Used by Approval enqueue + Inbox regenerate. Style examples come from Policy.
 */

import "server-only";

import OpenAI from "openai";
import {
  classifyNeighborCommentAiError,
  type NeighborCommentAiErrorType,
} from "@/lib/neighborCommentAiError";
import {
  classifyCommentSituationHeuristic,
  isCommentSituation,
  parseCommentSituation,
  type CommentSituation,
} from "@/lib/commentSituation";
import type { PolicyProfile } from "@/workers/types";

export type CommentDraftSource = "llm" | "fallback" | "mock";

export type CommentDraftVariant = "default" | "neighbor_feed";

export type CommentDraftInput = {
  title: string;
  content: string;
  styleExamples: string[];
  toneBase?: string;
  bannedPhrases?: string[];
  /** User- or AI-selected situation for prompt steering. */
  situation?: CommentSituation;
  /** neighbor_feed uses relationship-building prompt (not visit greetings). */
  variant?: CommentDraftVariant;
  /** Compact keywords for neighbor_feed (no full body). */
  keywords?: string[];
  /** Category label for neighbor_feed (e.g. situation). */
  category?: string;
  /** Optional log context (neighbor_feed only). */
  blogId?: string;
};

export type CommentDraftResult = {
  body: string;
  alternatives: string[];
  source: CommentDraftSource;
  model: string | null;
  errorMessage?: string;
  /** Structured error for neighbor_feed (preferred over parsing errorMessage). */
  errorType?: NeighborCommentAiErrorType;
  situation?: CommentSituation;
  /** Persistable draft analytics payload */
  draftMeta?: CommentDraftMeta;
};

export type CommentDraftMeta = {
  source_title: string;
  source_summary: string;
  generated_comment: string;
  style_type: string;
  generated_at: string;
};

export type CommentStyleFromPolicy = {
  styleExamples: string[];
  toneBase: string;
  bannedPhrases: string[];
};

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 20_000;
const NEIGHBOR_DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 120;
/** Prompt target 8–25 chars; allow emoji + punctuation in post-process. */
const NEIGHBOR_MAX_CHARS = 32;
const NEIGHBOR_CONTENT_MAX = 280;
const NEIGHBOR_STYLE_EXAMPLES_MAX = 5;
const RATE_LIMIT_RETRY_DELAY_MS = 2000;
const HARD_FALLBACK = "사진 분위기 너무 좋은데욥??🤤";
const NEIGHBOR_FEED_FALLBACK = "사진 분위기 너무 좋은데욥??🤤";

export const COMMENT_DRAFT_RATE_LIMIT_MESSAGE = "잠시 후 다시 시도해주세요.";

const COMMENT_STYLE_EXAMPLES = [
  "음식들 진짜 맛있어 보이네용😊",
  "오!! 이건 처음 알았네요 감사합니다 😊",
  "여기 저장해둬야겠어용😆",
  "사진 분위기 너무 좋은데욥??🤤",
  "와아.. 여기 한번 가보고 싶어요!!😊",
  "사진 너무 예쁘네용ㅋㅎ🥹",
  "풍경 진짜 멋져여!! 😊",
  "우아 여기 디저트도 맛있어 보여요!!🥹",
  "사진보고 침 줄줄 흘리는 중임댜.. 🤤",
  "비주얼 미쳤네용ㅎㅎ🤤",
];

const COMMENT_STYLE_BANNED_PHRASES = [
  "잘 보고 갑니다",
  "포스팅 잘 보고 갑니다",
  "좋은 정보 감사합니다",
  "소통해요",
  "맞팔해요",
  "좋은 하루 보내세요",
  "글 잘 보고 갑니다",
  "잘 봤어요",
  "좋은 글 감사합니다",
  "유익한 정보",
  "유익한 글",
  "도움 됐어요",
  "도움됐어요",
  "정리 감사",
  "참고할게요",
  "잘 정리",
  "좋은 정보네요",
];

function mergedBanned(input: CommentDraftInput): string[] {
  const base = input.bannedPhrases ?? [];
  return [...base, ...COMMENT_STYLE_BANNED_PHRASES];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickToneEndingHint(): string {
  const r = Math.random();
  if (r < 0.6) {
    return "이번 댓글 말투: ~요 (예: ~네요, ~어요, ~해요)";
  }
  if (r < 0.85) {
    return "이번 댓글 말투: ~용 (예: ~네용, ~어용)";
  }
  if (r < 0.95) {
    return "이번 댓글 말투: ~욥 또는 ~댜 (예: ~인데욥, ~중임댜)";
  }
  return "이번 댓글 말투: ㅎㅎ 또는 ㅋㅎ로 마무리";
}

function buildCommentStylePromptBlock(): string {
  return [
    "댓글 스타일 규칙:",
    "- 길이 8~25자 (이모지 제외)",
    "- 1~2문장",
    "- 본문 내용을 반드시 하나 언급",
    "- 마지막에는 이모지 1개만 붙이기",
    "- 웃음은 \"ㅎㅎ\" 또는 \"ㅋㅎ\"만 사용",
    "- \"ㅋㅋ\", \"^^\", \"~^^\" 사용 금지",
    "",
    "말투 다양성 (매 생성마다 하나만, alternatives는 서로 다른 말투):",
    "- 60% → \"~요\"",
    "- 25% → \"~용\"",
    "- 10% → \"~욥\", \"~댜\"",
    "- 5% → 웃음으로 마무리 (ㅎㅎ/ㅋㅎ)",
    "",
    "문장부호: !, ., ? 는 두개씩 — !!, .., ??",
    "절대 같은 말투가 2~3개 연속 생성되지 않도록 랜덤화",
    "",
    "좋은 예:",
    ...COMMENT_STYLE_EXAMPLES.map((e) => `- ${e}`),
    "",
    "금지 표현 (절대 생성 금지):",
    ...COMMENT_STYLE_BANNED_PHRASES.map((p) => `- ${p}.`),
    "",
    '- JSON만 출력: {"body":"...","alternatives":["..."]}',
    "- alternatives 0~2개, body와 다른 말투·다른 각도",
  ].join("\n");
}

async function withRateLimitRetry(
  attempt: () => Promise<CommentDraftResult>,
  onRetry?: () => void,
): Promise<CommentDraftResult> {
  const first = await attempt();
  if (first.source !== "fallback" || first.errorType !== "rate_limit") {
    return first;
  }
  onRetry?.();
  await sleep(RATE_LIMIT_RETRY_DELAY_MS);
  const second = await attempt();
  if (second.source === "fallback" && second.errorType === "rate_limit") {
    return {
      ...second,
      errorMessage: COMMENT_DRAFT_RATE_LIMIT_MESSAGE,
    };
  }
  return second;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read saved comment style examples from policy_profile.tone. */
export function commentStyleFromPolicy(
  policy: PolicyProfile,
): CommentStyleFromPolicy {
  const tone = asRecord(policy.tone);
  return {
    styleExamples: asStringArray(
      tone.comment_examples ?? tone.commentExamples,
    ).slice(0, 40),
    toneBase:
      typeof tone.base === "string"
        ? tone.base
        : typeof tone.style === "string"
          ? tone.style
          : "",
    bannedPhrases: policy.banned_phrases ?? [],
  };
}

export function commentAiProvider(): "mock" | "openai" {
  const raw = (process.env.COMMENT_AI_PROVIDER ?? "mock").trim().toLowerCase();
  return raw === "openai" ? "openai" : "mock";
}

export function commentAiModel(): string {
  const m = process.env.COMMENT_AI_MODEL?.trim();
  return m || DEFAULT_MODEL;
}

/** Neighbor-feed comment drafts — dedicated model (default gpt-4o-mini). */
export function neighborCommentAiModel(): string {
  const m = process.env.NEIGHBOR_COMMENT_AI_MODEL?.trim();
  return m || commentAiModel() || DEFAULT_MODEL;
}

export function commentAiTimeoutMs(): number {
  const n = Number(process.env.COMMENT_AI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

/** Neighbor-feed OpenAI timeout (default 30s). */
export function neighborCommentAiTimeoutMs(): number {
  const n = Number(process.env.NEIGHBOR_COMMENT_AI_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) {
    return Math.min(60_000, Math.max(10_000, Math.floor(n)));
  }
  return NEIGHBOR_DEFAULT_TIMEOUT_MS;
}

export function commentAiMaxChars(): number {
  const n = Number(process.env.COMMENT_AI_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CHARS;
}

/** Keep at most ~2 sentences / max chars; strip banned phrases. */
export function normalizeCommentDraft(
  raw: string,
  opts?: { maxChars?: number; bannedPhrases?: string[] },
): string {
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/^["'「『]|["'」』]$/g, "").trim();

  const banned = (opts?.bannedPhrases ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  for (const phrase of banned) {
    if (!phrase) continue;
    text = text.split(phrase).join("").replace(/\s+/g, " ").trim();
  }

  const parts = text
    .split(/(?<=[.!?…。！？])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 2) {
    text = parts.slice(0, 2).join(" ");
  } else if (parts.length === 0) {
    const lines = raw
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    text = lines.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
  }

  const maxChars = opts?.maxChars ?? commentAiMaxChars();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trim();
    const cut = Math.max(text.lastIndexOf(" "), text.lastIndexOf("."));
    if (cut > maxChars * 0.5) text = text.slice(0, cut).trim();
  }

  return text;
}

export function buildStyleAwareFallback(
  input: CommentDraftInput,
): { body: string; alternatives: string[] } {
  const examples = input.styleExamples
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) =>
      normalizeCommentDraft(e, {
        bannedPhrases: input.bannedPhrases,
      }),
    )
    .filter(Boolean);

  if (examples.length === 0) {
    return { body: HARD_FALLBACK, alternatives: [] };
  }

  const sorted = [...examples].sort((a, b) => a.length - b.length);
  const body = sorted[0]!;
  const alternatives = sorted.slice(1, 3).filter((a) => a !== body);

  return {
    body: normalizeCommentDraft(body, {
      bannedPhrases: input.bannedPhrases,
    }),
    alternatives,
  };
}

function buildMockDraft(input: CommentDraftInput): CommentDraftResult {
  const tip = input.title.trim() || "포스팅";
  const banned = mergedBanned(input);
  if (input.variant === "neighbor_feed") {
    const situation = input.situation ?? "공감";
    const anchor = tip.replace(/\s+/g, " ").trim().slice(0, 8) || "사진";
    const pool: Record<string, string[]> = {
      맛집: [
        `${anchor} 보니 음식이 정말 먹음직스럽네요`,
        `다음에 한번 가보고 싶네요 😊`,
        `${anchor} 분위기까지 좋아 보이네요`,
      ],
      여행: [
        `${anchor} 코스 보니까 한번 가보고 싶네요`,
        `사진만 봐도 여행 기분이 나네요`,
        `${anchor} 풍경이 정말 좋네요 😊`,
      ],
      정보: [
        `정리 잘 되어 있어서 이해하기 좋네요`,
        `덕분에 좋은 포인트 알아갑니다`,
        `${anchor} 부분 참고가 됐어요`,
      ],
      공감: [
        `사진 보니까 분위기가 정말 좋네요 😊`,
        `저도 비슷한 경험 있는데 공감됩니다`,
        `${anchor} 이야기 읽으니 마음이 편해지네요`,
        `이런 소소한 순간이 참 좋네요`,
      ],
    };
    const options = pool[situation] ?? pool.공감!;
    const idx =
      Math.abs(
        Array.from(tip).reduce((acc, ch) => acc + ch.charCodeAt(0), 0),
      ) % options.length;
    const body = normalizeCommentDraft(options[idx]!, {
      bannedPhrases: banned,
      maxChars: NEIGHBOR_MAX_CHARS,
    });
    return {
      body: body || NEIGHBOR_FEED_FALLBACK,
      alternatives: options.filter((_, i) => i !== idx).slice(0, 2).map((o) =>
        normalizeCommentDraft(o, {
          bannedPhrases: banned,
          maxChars: NEIGHBOR_MAX_CHARS,
        }),
      ),
      source: "mock",
      model: null,
      situation: input.situation,
    };
  }
  const examples = input.styleExamples.map((e) => e.trim()).filter(Boolean);
  let body: string;
  if (examples[0]) {
    const base = normalizeCommentDraft(examples[0], {
      bannedPhrases: banned,
    });
    body =
      base.length < 20
        ? normalizeCommentDraft(`${base} ${tip} 이야기도 인상적이었어요.`, {
            bannedPhrases: banned,
          })
        : base;
  } else {
    body = HARD_FALLBACK;
  }
  const alternatives = examples
    .slice(1, 3)
    .map((e) =>
      normalizeCommentDraft(e, { bannedPhrases: banned }),
    )
    .filter(Boolean);
  return {
    body,
    alternatives,
    source: "mock",
    model: null,
    situation: input.situation,
  };
}

function buildSystemPrompt(variant: CommentDraftVariant = "default"): string {
  const intro =
    variant === "neighbor_feed"
      ? [
          "당신은 네이버 블로그 이웃 새글을 실제로 읽고 남기는 짧은 댓글을 작성합니다.",
          "실제 사람이 글을 보고 순간적으로 반응한 댓글처럼 써주세요.",
          "제목·요약·키워드만 보고 소재 1개를 골라 반응합니다.",
        ]
      : [
          "당신은 네이버 블로그 이웃 글을 실제로 읽고 남기는 짧은 댓글을 작성합니다.",
          "실제 사람이 글을 보고 순간적으로 반응한 댓글처럼 써주세요.",
          "본문 요약·재설명·리뷰어 말투는 금지합니다.",
        ];
  return [...intro, "", buildCommentStylePromptBlock()].join("\n");
}

function buildUserPrompt(input: CommentDraftInput): string {
  const bannedList = mergedBanned(input);
  const exampleLimit =
    input.variant === "neighbor_feed" ? NEIGHBOR_STYLE_EXAMPLES_MAX : 40;
  const examples =
    input.styleExamples.filter((e) => e.trim()).length > 0
      ? input.styleExamples
          .filter((e) => e.trim())
          .slice(0, exampleLimit)
          .map((e, i) => `${i + 1}. ${e.trim()}`)
          .join("\n")
      : "(예시 없음 — 친근한 서로이웃 말투)";
  const banned = bannedList.filter((p) => p.trim()).join(", ") || "(없음)";
  const situation = input.situation ?? "공감";

  if (input.variant === "neighbor_feed") {
    const toneHint =
      input.toneBase?.trim() ||
      "서로이웃, 따뜻하고 자연스러움, 대화가 이어질 여지";
    const summary = compactNeighborContent(input.content);
    const keywords =
      (input.keywords ?? [])
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 8)
        .join(", ") || "(없음)";
    const category = (input.category ?? situation).trim() || situation;
    return [
      `기본 톤: ${toneHint}`,
      `카테고리: ${category}`,
      `상황: ${situation}`,
      pickToneEndingHint(),
      `금지어(절대 사용 금지): ${banned}`,
      "",
      "입력은 제목·요약·키워드·카테고리만 사용하세요. 전체 본문은 없습니다.",
      "",
      "작성 가이드:",
      "- 제목·요약·키워드에서 소재 1개를 골라 본문 내용을 반드시 언급",
      "- 실제 사람이 남기는 짧은 순간 반응 (1~2문장, 8~25자)",
      "- 마지막에 이모지 1개만, ㅎㅎ/ㅋㅎ만 허용 (ㅋㅋ/^^/~^^ 금지)",
      "- 과한 칭찬·광고·리뷰어 멘트·금지 표현 금지",
      "",
      "내 댓글 스타일 참고(있으면):",
      examples,
      "",
      `글 제목: ${input.title.trim() || "(제목 없음)"}`,
      `본문 요약: ${summary || "(요약 없음)"}`,
      `핵심 키워드: ${keywords}`,
      `카테고리: ${category}`,
    ].join("\n");
  }

  const toneHint =
    input.toneBase?.trim() ||
    "친근한 이웃, 짧고 자연스러운 일상 말투";
  return [
    `기본 톤: ${toneHint}`,
    `상황 카테고리: ${situation}`,
    pickToneEndingHint(),
    `금지어: ${banned}`,
    "",
    "작성 가이드:",
    "- 본문에서 소재 1개를 골라 내용을 반드시 언급 (요약·재설명 금지)",
    "- 실제 사람의 짧은 순간 반응 (1~2문장, 8~25자)",
    "- 마지막에 이모지 1개만, ㅎㅎ/ㅋㅎ만 허용",
    "- 예시 말투 참고, 리뷰어/GPT/금지 표현 금지",
    "",
    "내 댓글 예시:",
    examples,
    "",
    `글 제목: ${input.title.trim() || "(제목 없음)"}`,
    "글 본문/요약 (소재 고르는 용도 — 요약해서 쓰지 말 것):",
    input.content.trim() || "(본문 없음)",
  ].join("\n");
}

/** Neighbor-feed: title/summary only — never full post body. */
export function compactNeighborContent(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= NEIGHBOR_CONTENT_MAX) return text;
  return `${text.slice(0, NEIGHBOR_CONTENT_MAX).trim()}…`;
}

function extractNeighborKeywords(title: string, summary: string): string[] {
  const blob = `${title} ${summary}`.replace(/\s+/g, " ").trim();
  if (!blob) return [];
  const tokens = blob
    .split(/[\s,/|·•]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, "").trim())
    .filter((t) => t.length >= 2 && t.length <= 16);
  const uniq: string[] = [];
  for (const t of tokens) {
    if (!uniq.includes(t)) uniq.push(t);
    if (uniq.length >= 6) break;
  }
  return uniq;
}

function parseLlmJson(content: string): {
  body: string;
  alternatives: string[];
} | null {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fence?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as {
      body?: unknown;
      alternatives?: unknown;
    };
    if (typeof parsed.body !== "string" || !parsed.body.trim()) return null;
    const alternatives = Array.isArray(parsed.alternatives)
      ? parsed.alternatives.filter(
          (x): x is string => typeof x === "string" && Boolean(x.trim()),
        )
      : [];
    return { body: parsed.body, alternatives };
  } catch {
    if (trimmed && !trimmed.startsWith("{")) {
      return { body: trimmed, alternatives: [] };
    }
    return null;
  }
}

function openAiClient(timeoutMs?: number) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
    timeout: timeoutMs ?? commentAiTimeoutMs(),
    maxRetries: 0,
  });
}

function logNeighborCommentAi(
  event: string,
  fields: Record<string, unknown>,
): void {
  console.info("[neighbor-comment-ai]", event, fields);
}

async function generateNeighborViaOpenAi(
  input: CommentDraftInput,
): Promise<CommentDraftResult> {
  const banned = mergedBanned(input);
  const timeoutMs = neighborCommentAiTimeoutMs();
  const model = neighborCommentAiModel();
  const title = input.title.trim() || "(제목 없음)";
  const blogId = input.blogId?.trim() || null;

  const client = openAiClient(timeoutMs);
  if (!client) {
    const classified = classifyNeighborCommentAiError("OPENAI_API_KEY missing");
    logNeighborCommentAi("error", {
      title,
      blog_id: blogId,
      errorType: classified.errorType,
      message: classified.raw,
    });
    return {
      body: "",
      alternatives: [],
      source: "fallback",
      model: null,
      errorMessage: classified.raw,
      errorType: classified.errorType,
      situation: input.situation,
    };
  }

  async function once(attempt: number): Promise<CommentDraftResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    logNeighborCommentAi("request start", {
      title,
      blog_id: blogId,
      model,
      timeoutMs,
      attempt,
    });

    try {
      const completion = await client!.chat.completions.create(
        {
          model,
          temperature: 0.85,
          max_completion_tokens: 160,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: buildSystemPrompt("neighbor_feed") },
            {
              role: "user",
              content: buildUserPrompt({
                ...input,
                bannedPhrases: banned,
                variant: "neighbor_feed",
              }),
            },
          ],
        },
        { signal: controller.signal },
      );

      const raw = completion.choices[0]?.message?.content ?? "";
      const parsed = parseLlmJson(raw);
      if (!parsed) {
        const classified = classifyNeighborCommentAiError(
          "empty_or_unparseable_llm_response",
        );
        logNeighborCommentAi("error", {
          title,
          blog_id: blogId,
          duration: Date.now() - started,
          errorType: classified.errorType,
          message: classified.raw,
          attempt,
        });
        return {
          body: "",
          alternatives: [],
          source: "fallback",
          model,
          errorMessage: classified.raw,
          errorType: classified.errorType,
          situation: input.situation,
        };
      }

      const body = normalizeCommentDraft(parsed.body, {
        bannedPhrases: banned,
        maxChars: NEIGHBOR_MAX_CHARS,
      });
      if (!body) {
        const classified = classifyNeighborCommentAiError(
          "normalized_body_empty",
        );
        logNeighborCommentAi("error", {
          title,
          blog_id: blogId,
          duration: Date.now() - started,
          errorType: classified.errorType,
          message: classified.raw,
          attempt,
        });
        return {
          body: "",
          alternatives: [],
          source: "fallback",
          model,
          errorMessage: classified.raw,
          errorType: classified.errorType,
          situation: input.situation,
        };
      }

      const alternatives = parsed.alternatives
        .map((a) =>
          normalizeCommentDraft(a, {
            bannedPhrases: banned,
            maxChars: NEIGHBOR_MAX_CHARS,
          }),
        )
        .filter((a) => a && a !== body)
        .slice(0, 2);

      logNeighborCommentAi("response success", {
        title,
        blog_id: blogId,
        duration: Date.now() - started,
        attempt,
      });

      return {
        body,
        alternatives,
        source: "llm",
        model,
        situation: input.situation,
      };
    } catch (err) {
      const classified = classifyNeighborCommentAiError(err);
      const status =
        err &&
        typeof err === "object" &&
        "status" in err &&
        typeof (err as { status: unknown }).status === "number"
          ? (err as { status: number }).status
          : undefined;
      logNeighborCommentAi("error", {
        title,
        blog_id: blogId,
        duration: Date.now() - started,
        errorType: classified.errorType,
        status: status ?? null,
        message: classified.raw,
        attempt,
      });
      return {
        body: "",
        alternatives: [],
        source: "fallback",
        model,
        errorMessage: classified.raw,
        errorType: classified.errorType,
        situation: input.situation,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  let attempt = 0;
  return withRateLimitRetry(
    () => {
      attempt += 1;
      return once(attempt);
    },
    () => {
      logNeighborCommentAi("rate_limit retry", {
        title,
        blog_id: blogId,
        delayMs: RATE_LIMIT_RETRY_DELAY_MS,
      });
    },
  );
}

async function generateViaOpenAi(
  input: CommentDraftInput,
): Promise<CommentDraftResult> {
  const banned = mergedBanned(input);
  const variant = input.variant ?? "default";
  if (variant === "neighbor_feed") {
    return generateNeighborViaOpenAi(input);
  }

  const timeoutMs = commentAiTimeoutMs();
  const model = commentAiModel();
  const client = openAiClient(timeoutMs);
  if (!client) {
    return {
      ...buildStyleAwareFallback(input),
      source: "fallback",
      model: null,
      errorMessage: "OPENAI_API_KEY missing",
      situation: input.situation,
    };
  }

  const ai = client;

  let attempt = 0;

  async function runAttempt(): Promise<CommentDraftResult> {
    attempt += 1;
    try {
      const completion = await ai.chat.completions.create({
        model,
        temperature: 0.85,
        max_completion_tokens: 220,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(variant) },
          {
            role: "user",
            content: buildUserPrompt({ ...input, bannedPhrases: banned }),
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "";
      const parsed = parseLlmJson(raw);
      if (!parsed) {
        return {
          ...buildStyleAwareFallback(input),
          source: "fallback",
          model,
          errorMessage: "empty_or_unparseable_llm_response",
          situation: input.situation,
        };
      }

      const body = normalizeCommentDraft(parsed.body, {
        bannedPhrases: banned,
      });
      if (!body) {
        return {
          ...buildStyleAwareFallback(input),
          source: "fallback",
          model,
          errorMessage: "normalized_body_empty",
          situation: input.situation,
        };
      }

      const alternatives = parsed.alternatives
        .map((a) =>
          normalizeCommentDraft(a, {
            bannedPhrases: banned,
          }),
        )
        .filter((a) => a && a !== body)
        .slice(0, 2);

      return {
        body,
        alternatives,
        source: "llm",
        model,
        situation: input.situation,
      };
    } catch (err) {
      const classified = classifyNeighborCommentAiError(err);
      return {
        ...buildStyleAwareFallback(input),
        source: "fallback",
        model,
        errorMessage: classified.raw,
        errorType: classified.errorType,
        situation: input.situation,
      };
    }
  }

  return withRateLimitRetry(runAttempt);
}

/**
 * Classify post into 맛집/여행/공감/정보.
 * OpenAI when available; otherwise keyword heuristic.
 */
export async function classifyCommentSituation(
  title: string,
  content: string,
): Promise<{
  situation: CommentSituation;
  source: CommentDraftSource;
  model: string | null;
}> {
  const heuristic = classifyCommentSituationHeuristic(title, content);
  if (commentAiProvider() === "mock") {
    return { situation: heuristic, source: "mock", model: null };
  }

  const client = openAiClient();
  if (!client) {
    return { situation: heuristic, source: "fallback", model: null };
  }

  const model = commentAiModel();
  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_completion_tokens: 40,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            '블로그 글의 댓글 상황을 하나만 고르세요. JSON: {"situation":"맛집"|"여행"|"공감"|"정보"}',
        },
        {
          role: "user",
          content: `제목: ${title}\n본문: ${content.slice(0, 1200)}`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { situation?: unknown };
    if (isCommentSituation(parsed.situation)) {
      return { situation: parsed.situation, source: "llm", model };
    }
    return { situation: heuristic, source: "fallback", model };
  } catch {
    return { situation: heuristic, source: "fallback", model };
  }
}

/**
 * Generate a 1–2 line comment draft.
 * provider=mock → local mock; openai → Chat Completions; errors → style-aware fallback.
 */
export async function generateCommentDraft(
  input: CommentDraftInput,
): Promise<CommentDraftResult> {
  const situation = input.situation
    ? parseCommentSituation(input.situation)
    : undefined;
  const normalized: CommentDraftInput = {
    title: input.title ?? "",
    content: input.content ?? "",
    styleExamples: Array.isArray(input.styleExamples)
      ? input.styleExamples
      : [],
    toneBase: input.toneBase,
    bannedPhrases: input.bannedPhrases,
    situation,
    variant: input.variant ?? "default",
    keywords: input.keywords,
    category: input.category,
    blogId: input.blogId,
  };

  if (commentAiProvider() === "mock") {
    return buildMockDraft(normalized);
  }

  return generateViaOpenAi(normalized);
}

/** Classify (if needed) then generate draft for Approval flow. */
export async function generateCommentDraftForPost(input: {
  title: string;
  content: string;
  styleExamples: string[];
  toneBase?: string;
  bannedPhrases?: string[];
  situation?: CommentSituation;
  variant?: CommentDraftVariant;
  keywords?: string[];
  category?: string;
  blogId?: string;
}): Promise<CommentDraftResult & { situation: CommentSituation }> {
  let situation = input.situation;
  // Neighbor feed: heuristic only (skip extra OpenAI classify round-trip).
  if (!situation) {
    if (input.variant === "neighbor_feed") {
      situation = classifyCommentSituationHeuristic(
        input.title,
        input.content,
      );
    } else {
      const classified = await classifyCommentSituation(
        input.title,
        input.content,
      );
      situation = classified.situation;
    }
  }

  const content =
    input.variant === "neighbor_feed"
      ? compactNeighborContent(input.content)
      : input.content;
  const keywords =
    input.keywords ??
    (input.variant === "neighbor_feed"
      ? extractNeighborKeywords(input.title, content)
      : undefined);
  const styleExamples =
    input.variant === "neighbor_feed"
      ? input.styleExamples.slice(0, NEIGHBOR_STYLE_EXAMPLES_MAX)
      : input.styleExamples;

  const draft = await generateCommentDraft({
    ...input,
    content,
    styleExamples,
    keywords,
    category: input.category ?? situation,
    situation,
    blogId: input.blogId,
  });
  const generated_at = new Date().toISOString();
  const draftMeta: CommentDraftMeta = {
    source_title: (input.title ?? "").trim().slice(0, 200),
    source_summary: content.trim().slice(0, 280),
    generated_comment: draft.body,
    style_type: situation,
    generated_at,
  };
  return { ...draft, situation, draftMeta };
}
