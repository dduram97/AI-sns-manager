/**
 * Phase 1: generate a comment draft (no Naver / Approval / DB).
 *
 * Usage:
 *   npm run draft:comment -- \
 *     --title "주말 카페 후기" \
 *     --content "조용한 자리와 라떼가 좋았어요." \
 *     --example "사진 분위기가 정말 좋네요." \
 *     --example "글 잘 봤어요. 저도 가보고 싶어요."
 *
 * Force fallback path (no API call):
 *   npm run draft:comment -- --fallback-only --example "..."
 *
 * OpenAI:
 *   COMMENT_AI_PROVIDER=openai OPENAI_API_KEY=... npm run draft:comment -- ...
 */

import { config as loadEnv } from "dotenv";
import {
  buildStyleAwareFallback,
  generateCommentDraft,
} from "../src/services/commentDraftService";

loadEnv({ path: ".env" });

function readFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function readAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      out.push(args[i + 1]!);
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (readFlag(args, "--help") || readFlag(args, "-h")) {
    console.log(`Usage:
  npm run draft:comment -- --title "..." --content "..." --example "..." [--example "..."]
  npm run draft:comment -- --fallback-only --example "내 말투 예시"
  npm run draft:comment -- --fallback-only --no-examples
  Env: COMMENT_AI_PROVIDER=mock|openai  OPENAI_API_KEY  COMMENT_AI_MODEL`);
    return;
  }

  const title =
    readOpt(args, "--title") ?? "테스트 글: 동네 산책 후기";
  const content =
    readOpt(args, "--content") ??
    "오늘 공원 산책하다가 벚꽃 길이 예뻐서 한참 걸었어요. 바람도 선선하고 커피 한잔 하기 좋은 날이었습니다.";
  const examples = readAll(args, "--example")
    .map((e) => e.trim())
    .filter(Boolean);
  const noExamples = readFlag(args, "--no-examples");
  const styleExamples = noExamples
    ? []
    : examples.length > 0
      ? examples
      : [
          "사진 분위기가 정말 좋네요.",
          "글 잘 봤어요. 저도 가보고 싶어요.",
        ];
  const toneBase = readOpt(args, "--tone");
  const banned = readAll(args, "--banned");

  if (readFlag(args, "--fallback-only")) {
    const fb = buildStyleAwareFallback({
      title,
      content,
      styleExamples,
      toneBase,
      bannedPhrases: banned,
    });
    console.log(
      JSON.stringify(
        {
          body: fb.body,
          alternatives: fb.alternatives,
          source: "fallback",
          model: null,
          note: "style-aware fallback (no LLM call)",
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await generateCommentDraft({
    title,
    content,
    styleExamples,
    toneBase,
    bannedPhrases: banned,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
