/**
 * Naver Blog public RSS — fast recent-post listing without CDP/login.
 * URL: https://rss.blog.naver.com/{blogId}.xml
 */

import type { NaverPostSnapshot } from "./posts";
import { summarizeContent } from "./posts";
import { parseNaverPostKeyFromUrl } from "@/lib/naverPostKey";

const RSS_TIMEOUT_MS = 8_000;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function tagText(block: string, tag: string): string {
  const cdata = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
    "i",
  ).exec(block);
  if (cdata?.[1] != null) return decodeXmlEntities(cdata[1]);
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(
    block,
  );
  return plain?.[1] ? decodeXmlEntities(plain[1]) : "";
}

function parsePubDate(raw: string): string | null {
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  return null;
}

function logNoFromLink(link: string, blogId: string): string | null {
  const key = parseNaverPostKeyFromUrl(link);
  if (key) {
    const [, logNo] = key.split(":");
    if (logNo && /^\d+$/.test(logNo)) return logNo;
  }
  const m = link.match(new RegExp(`${blogId}/(\\d+)`, "i"));
  return m?.[1] ?? null;
}

export async function fetchBlogRecentPostsViaRss(
  blogId: string,
  limit = 5,
): Promise<NaverPostSnapshot[]> {
  const id = blogId.trim();
  if (!id) return [];

  const urls = [
    `https://rss.blog.naver.com/${encodeURIComponent(id)}.xml`,
    `https://blog.rss.naver.com/${encodeURIComponent(id)}.xml`,
  ];

  let xml = "";
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), RSS_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "User-Agent": "AI-SNS-Manager/1.0 (neighbor-feed)",
        },
        cache: "no-store",
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`RSS HTTP ${res.status}`);
        continue;
      }
      xml = await res.text();
      if (xml.includes("<item")) break;
      lastErr = new Error("RSS empty items");
    } catch (err) {
      lastErr = err;
    }
  }

  if (!xml.includes("<item")) {
    if (lastErr) {
      console.warn(
        "[naverBlogRss]",
        id,
        lastErr instanceof Error ? lastErr.message : lastErr,
      );
    }
    return [];
  }

  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const posts: NaverPostSnapshot[] = [];

  for (const block of items) {
    if (posts.length >= limit) break;
    const title = tagText(block, "title") || "새 글";
    const link = tagText(block, "link") || tagText(block, "guid");
    const description = tagText(block, "description");
    const pubDate = parsePubDate(tagText(block, "pubDate"));
    if (!link) continue;
    const logNo = logNoFromLink(link, id);
    if (!logNo) continue;

    const postUrl = link.includes("blog.naver.com")
      ? link.replace(/^http:\/\//i, "https://")
      : `https://m.blog.naver.com/${id}/${logNo}`;

    posts.push({
      blogId: id,
      logNo,
      postUrl,
      title,
      contentRaw: description,
      contentSummary: summarizeContent(description || title, 280),
      publishedAt: pubDate,
    });
  }

  return posts;
}
