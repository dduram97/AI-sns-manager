/**
 * Discover ingest — keyword candidates → Person(stage=discover) + Workflow.
 * Decision Engine unchanged; tick Decision advances discover → warming → …
 */

import { NaverDiscoverAdapter } from "../adapters/naver/NaverDiscoverAdapter";
import type { DiscoverCandidate } from "../adapters/naver/NaverDiscoverAdapter";
import { getDiscoverPolicy } from "../domain/policy/discoverPolicy";
import type { Repositories } from "../repositories/index";
import type { Person } from "./types";

export interface DiscoverIngestResult {
  keywords: string[];
  candidatesSeen: number;
  personsCreated: number;
  skippedExisting: number;
  errors: string[];
  createdPersonIds: string[];
}

function discoverMetaFromCandidate(
  c: DiscoverCandidate,
): Record<string, unknown> {
  return {
    blog_id: c.blogId,
    blog_url: c.url,
    source: "naver_discover",
    keyword_relevance: c.keywordRelevance,
    matched_keywords: c.matchedKeywords,
    recently_active: c.recentlyActive,
    last_post_at: c.lastPostAt,
    date_text: c.dateText,
    category_hint: c.categoryHint,
    snippet: c.snippet,
    recommend_score: c.keywordRelevance,
    reasons: [
      ...(c.matchedKeywords.length > 0
        ? [`키워드 일치: ${c.matchedKeywords.join(", ")}`]
        : []),
      ...(c.recentlyActive ? ["최근 활동"] : []),
      ...(c.categoryHint ? [`카테고리: ${c.categoryHint}`] : []),
    ],
  };
}

async function createDiscoverPerson(
  repos: Repositories,
  candidate: DiscoverCandidate,
): Promise<Person> {
  const person = await repos.createPerson({
    display_name: candidate.blogName.slice(0, 80) || candidate.blogId,
    discover_meta: discoverMetaFromCandidate(candidate),
  });

  await repos.upsertBlogIdentity({
    person_id: person.id,
    blog_id: candidate.blogId,
    profile_snapshot: {
      url: candidate.url,
      name: candidate.blogName,
      snippet: candidate.snippet,
    },
  });

  await repos.updateRelationship(person.id, {
    stage: "discover",
    score: Math.min(100, candidate.keywordRelevance),
    temperature: candidate.recentlyActive ? 25 : 10,
  });

  const workflow = await repos.createWorkflow({
    person_id: person.id,
    current_stage: "discover",
    current_state: "active",
    next_action: "visit",
    last_decision_id: null,
    priority: 30 + Math.min(40, Math.floor(candidate.keywordRelevance / 2)),
    goal: "discover_to_warming",
  });
  await repos.setPersonActiveWorkflow(person.id, workflow.id);

  return person;
}

/**
 * Run Discover → create Person(discover) for new blog_ids.
 */
export async function ingestDiscoverCandidates(
  repos: Repositories,
  adapter?: NaverDiscoverAdapter,
): Promise<DiscoverIngestResult> {
  const policy = await repos.getPolicy();
  const discover = getDiscoverPolicy(policy);
  const result: DiscoverIngestResult = {
    keywords: discover.search_keywords,
    candidatesSeen: 0,
    personsCreated: 0,
    skippedExisting: 0,
    errors: [],
    createdPersonIds: [],
  };

  if (!discover.active || discover.search_keywords.length === 0) {
    return result;
  }

  const discoverAdapter = adapter ?? new NaverDiscoverAdapter();
  let candidates: DiscoverCandidate[] = [];
  try {
    candidates = await discoverAdapter.searchCandidates(discover);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return result;
  }

  result.candidatesSeen = candidates.length;

  for (const c of candidates) {
    try {
      const existing = await repos.findPersonIdByBlogId(c.blogId);
      if (existing) {
        result.skippedExisting += 1;
        continue;
      }
      const person = await createDiscoverPerson(repos, c);
      result.personsCreated += 1;
      result.createdPersonIds.push(person.id);
    } catch (err) {
      result.errors.push(
        `${c.blogId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
