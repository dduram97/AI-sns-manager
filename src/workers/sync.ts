/**
 * Naver Blog Sync → PerceptionEvent ingest.
 * Does not modify Decision Engine. Tick consumes unprocessed perceptions.
 */

import { NaverBlogAdapter } from "../adapters/naver/NaverBlogAdapter";
import type { NaverPostSnapshot } from "../adapters/naver/posts";
import type { Repositories } from "../repositories/index";
import type { PerceptionEvent } from "./types";

export interface BlogSyncTarget {
  personId: string;
  blogId: string;
  displayName?: string;
}

export interface BlogSyncResult {
  targets: number;
  postsSeen: number;
  perceptionsCreated: number;
  skippedDuplicates: number;
  errors: string[];
  created: PerceptionEvent[];
}

export type BlogSyncOptions = {
  /** Only sync these person ids (verify isolation). */
  personIds?: string[];
  /**
   * Ops tick: skip verify-tagged persons (default).
   * Verify script sets includeVerifyPersons when personIds scopes the run.
   */
  includeVerifyPersons?: boolean;
};

function isVerifyMeta(meta: Record<string, unknown>): boolean {
  return meta.verify === true;
}

function blogIdFromDiscoverMeta(meta: Record<string, unknown>): string | null {
  const v =
    meta.blog_id ?? meta.blogId ?? meta.naver_blog_id ?? meta.external_key;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Resolve managed persons with a Naver blog id
 * (channel_identities.blog ∪ persons.discover_meta).
 */
export async function listBlogSyncTargets(
  repos: Repositories,
  options?: BlogSyncOptions,
): Promise<BlogSyncTarget[]> {
  const allowIds = options?.personIds ? new Set(options.personIds) : null;
  const includeVerify = options?.includeVerifyPersons === true;

  const fromIdentities = await repos.listBlogChannelIdentities();
  const map = new Map<string, BlogSyncTarget>();

  for (const row of fromIdentities) {
    if (allowIds && !allowIds.has(row.person_id)) continue;
    map.set(row.person_id, {
      personId: row.person_id,
      blogId: row.external_key,
    });
  }

  const persons = await repos.listPersons();
  for (const p of persons) {
    if (allowIds && !allowIds.has(p.id)) continue;
    const meta = p.discover_meta ?? {};
    // Ops sync must not pull verify fixtures unless explicitly allowed / scoped
    if (!includeVerify && !allowIds && isVerifyMeta(meta)) continue;

    if (map.has(p.id)) {
      const cur = map.get(p.id)!;
      cur.displayName = p.display_name;
      continue;
    }
    const blogId = blogIdFromDiscoverMeta(meta);
    if (!blogId) continue;
    map.set(p.id, {
      personId: p.id,
      blogId,
      displayName: p.display_name,
    });
  }

  return [...map.values()];
}

function perceptionPayload(
  personId: string,
  post: NaverPostSnapshot,
): Record<string, unknown> {
  return {
    person_id: personId,
    channel: "blog",
    post_url: post.postUrl,
    title: post.title,
    content_summary: post.contentSummary,
    // Adapter / ActionJob target enrichment (Decision Engine unchanged)
    blog_id: post.blogId,
    post_id: post.logNo,
    log_no: post.logNo,
  };
}

/**
 * sync → new_post PerceptionEvents (idempotent by post_url)
 */
export async function ingestNaverBlogPerceptions(
  repos: Repositories,
  adapter?: NaverBlogAdapter,
  options?: BlogSyncOptions,
): Promise<BlogSyncResult> {
  const blogAdapter = adapter ?? new NaverBlogAdapter();
  const targets = await listBlogSyncTargets(repos, options);
  const result: BlogSyncResult = {
    targets: targets.length,
    postsSeen: 0,
    perceptionsCreated: 0,
    skippedDuplicates: 0,
    errors: [],
    created: [],
  };

  const limit = Number(process.env.NAVER_SYNC_POST_LIMIT ?? 5) || 5;

  for (const target of targets) {
    try {
      const posts = await blogAdapter.fetchLatestPosts(target.blogId, limit);
      result.postsSeen += posts.length;

      for (const post of posts) {
        const exists = await repos.perceptionExistsForPostUrl(post.postUrl);
        if (exists) {
          result.skippedDuplicates += 1;
          continue;
        }

        const occurredAt = post.publishedAt ?? new Date().toISOString();
        const event = await repos.insertPerception({
          person_id: target.personId,
          channel: "blog",
          event_type: "new_post",
          payload: perceptionPayload(target.personId, post),
          occurred_at: occurredAt,
        });
        result.created.push(event);
        result.perceptionsCreated += 1;
      }
    } catch (err) {
      const msg = `${target.blogId}: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      console.warn("[blogSync]", msg);
    }
  }

  // Warm session even when no targets (keeps cookies fresh)
  if (targets.length === 0) {
    await blogAdapter.sync().catch(() => undefined);
  }

  return result;
}
