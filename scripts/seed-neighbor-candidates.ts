/**
 * Seed operational neighbor candidates (NOT verify fixtures).
 * Shows up on /neighbors — Discover ingest is the production source;
 * this script only fills the empty list for UI testing.
 *
 *   npx tsx scripts/seed-neighbor-candidates.ts
 *
 * Cleanup (optional): delete persons where discover_meta.neighbor_seed=true
 */

import { createServiceClient } from "../src/lib/supabase";
import { createRepositories } from "../src/repositories/index";
import { listNeighborCandidates } from "../src/services/neighborService";
import type { RelationshipStage } from "../src/workers/types";

const CANDIDATES: Array<{
  blogId: string;
  blogName: string;
  nickname: string;
  keywords: string[];
  category: string;
  snippet: string;
  daysAgo: number;
}> = [
  {
    blogId: "soonim0127",
    blogName: "수니미의 하루",
    nickname: "수니미",
    keywords: ["일상", "취미"],
    category: "일상",
    snippet: "강아지와 함께하는 일상 기록",
    daysAgo: 3,
  },
  {
    blogId: "foodtripdiary",
    blogName: "맛있는 여행일기",
    nickname: "푸드트립",
    keywords: ["맛집", "여행"],
    category: "맛집 / 여행",
    snippet: "주말마다 찾은 로컬 맛집 후기",
    daysAgo: 5,
  },
  {
    blogId: "cafewalker92",
    blogName: "카페 산책",
    nickname: "카페워커",
    keywords: ["카페", "일상"],
    category: "카페",
    snippet: "동네 카페 분위기와 메뉴 메모",
    daysAgo: 2,
  },
  {
    blogId: "campingwithme",
    blogName: "캠핑하는 사람들",
    nickname: "캠핑러",
    keywords: ["여행", "취미"],
    category: "여행",
    snippet: "차박·캠핑 준비물과 장소 후기",
    daysAgo: 12,
  },
  {
    blogId: "golftime_kr",
    blogName: "주말 골프 노트",
    nickname: "골프타임",
    keywords: ["취미"],
    category: "취미",
    snippet: "스크린골프와 라운딩 기록",
    daysAgo: 8,
  },
  {
    blogId: "parentingsoft",
    blogName: "육아의 온도",
    nickname: "소프트맘",
    keywords: ["일상"],
    category: "일상",
    snippet: "아이와 산책·간식 일상",
    daysAgo: 1,
  },
  {
    blogId: "seoulsnackmap",
    blogName: "서울 간식 지도",
    nickname: "스낵맵",
    keywords: ["맛집", "카페"],
    category: "맛집 / 카페",
    snippet: "디저트·분식 맛집 지도형 후기",
    daysAgo: 6,
  },
  {
    blogId: "slowtripnote",
    blogName: "느린 여행 노트",
    nickname: "슬로우트립",
    keywords: ["여행"],
    category: "여행",
    snippet: "국내 소도시 당일치기 코스",
    daysAgo: 15,
  },
];

async function main() {
  const db = createServiceClient();
  const repos = createRepositories(db);
  const created: Array<{ personId: string; blogId: string }> = [];
  const skipped: string[] = [];

  for (const c of CANDIDATES) {
    const existing = await repos.findPersonIdByBlogId(c.blogId);
    if (existing) {
      // Ensure discover_meta is usable for neighbor list (non-verify)
      const person = await repos.getPerson(existing);
      const meta = person?.discover_meta ?? {};
      if (meta.verify === true) {
        // Don't mutate verify fixtures — create sibling person without identity conflict
        // by using a unique display person without upsert if identity exists.
        // Skip if channel identity already claimed by verify fixture.
        skipped.push(`${c.blogId} (identity owned by ${existing})`);
        continue;
      }
      skipped.push(`${c.blogId} (already exists ${existing})`);
      continue;
    }

    const lastPostAt = new Date(
      Date.now() - c.daysAgo * 86_400_000,
    ).toISOString();

    const person = await repos.createPerson({
      display_name: c.blogName,
      discover_meta: {
        blog_id: c.blogId,
        blog_url: `https://m.blog.naver.com/${c.blogId}`,
        nickname: c.nickname,
        matched_keywords: c.keywords,
        category_hint: c.category,
        snippet: c.snippet,
        recently_active: c.daysAgo <= 30,
        last_post_at: lastPostAt,
        last_activity_at: lastPostAt,
        recommend_score: 70 + Math.min(20, Math.floor(Math.random() * 20)),
        reasons: [
          `${c.keywords[0]} 관련 글 작성`,
          "최근 활동 확인",
          "일반 후기 비율 높음",
        ],
        source: "neighbor_seed",
        neighbor_seed: true,
      },
    });

    await repos.upsertBlogIdentity({
      person_id: person.id,
      blog_id: c.blogId,
      profile_snapshot: {
        url: `https://m.blog.naver.com/${c.blogId}`,
        name: c.blogName,
        snippet: c.snippet,
      },
    });

    await repos.updateRelationship(person.id, {
      stage: "discover" as RelationshipStage,
      score: 55,
      temperature: 30,
    });

    const workflow = await repos.createWorkflow({
      person_id: person.id,
      current_stage: "discover",
      current_state: "active",
      next_action: "visit",
      last_decision_id: null,
      priority: 45,
      goal: "neighbor_candidate",
    });
    await repos.setPersonActiveWorkflow(person.id, workflow.id);

    created.push({ personId: person.id, blogId: c.blogId });
  }

  // If all skipped due to identity, create persons WITHOUT channel_identity
  // so neighbor list still works (list uses discover_meta.blog_id only).
  if (created.length === 0) {
    for (const c of CANDIDATES) {
      const lastPostAt = new Date(
        Date.now() - c.daysAgo * 86_400_000,
      ).toISOString();
      const person = await repos.createPerson({
        display_name: c.blogName,
        discover_meta: {
          blog_id: c.blogId,
          blog_url: `https://m.blog.naver.com/${c.blogId}`,
          nickname: c.nickname,
          matched_keywords: c.keywords,
          category_hint: c.category,
          snippet: c.snippet,
          recently_active: true,
          last_post_at: lastPostAt,
          recommend_score: 75,
          reasons: [
            `${c.keywords[0]} 관련 글 작성`,
            "최근 활동 확인",
            "일반 후기 비율 높음",
          ],
          source: "neighbor_seed",
          neighbor_seed: true,
          // allow duplicate blog_id for UI when identity is locked by verify
          seed_note: "no_channel_identity",
        },
      });
      await repos.updateRelationship(person.id, {
        stage: "discover",
        score: 55,
        temperature: 30,
      });
      const workflow = await repos.createWorkflow({
        person_id: person.id,
        current_stage: "discover",
        current_state: "active",
        next_action: "visit",
        last_decision_id: null,
        priority: 45,
        goal: "neighbor_candidate",
      });
      await repos.setPersonActiveWorkflow(person.id, workflow.id);
      created.push({ personId: person.id, blogId: c.blogId });
    }
  }

  const listed = await listNeighborCandidates();

  console.log(
    JSON.stringify(
      {
        ok: true,
        created_count: created.length,
        skipped,
        created,
        listNeighborCandidates_count: listed.length,
        preview: listed.slice(0, 5).map((c) => ({
          blogName: c.blogName,
          blogId: c.blogId,
          score: c.recommendScore,
          category: c.category,
        })),
        note: "Production candidates come from Discover ingest (tick). This seed is for UI testing only.",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
