import { NextResponse } from "next/server";
import { fetchNaverBlogLikes } from "@/lib/naverBlogInboundApi";

export const dynamic = "force-dynamic";

/**
 * BFF: Node-side proxy to Naver blogfe like search (avoids browser CORS).
 * POST body: { blogId, logNo, cookie?, referer?, pageSize?, q?, callback? }
 * Upstream: apis.naver.com/blogfe/like/v1/search/contents
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      blogId?: string;
      logNo?: string;
      cookie?: string;
      referer?: string;
      pageSize?: number;
      q?: string;
      callback?: string;
    };
    const blogId = String(body.blogId ?? "").trim();
    const logNo = String(body.logNo ?? "").trim();
    if (!blogId || !logNo) {
      return NextResponse.json(
        { ok: false, error: "blogId and logNo are required" },
        { status: 400 },
      );
    }
    const referer =
      String(body.referer ?? "").trim() ||
      `https://m.blog.naver.com/${encodeURIComponent(blogId)}/${logNo}`;
    const { primary, attempts } = await fetchNaverBlogLikes({
      blogId,
      logNo,
      cookie: String(body.cookie ?? ""),
      referer,
      pageSize: body.pageSize,
      q: body.q,
      callback: body.callback,
    });
    return NextResponse.json({
      ok: primary.ok,
      status: primary.status,
      url: primary.url,
      method: primary.method,
      query: primary.query,
      requestHeaders: primary.requestHeaders,
      cookie: primary.cookie,
      referer: primary.referer,
      bodySnippet: primary.bodySnippet,
      json: primary.json,
      jsonParseOk: primary.jsonParseOk,
      error: primary.error,
      attempts: attempts.map((a) => ({
        url: a.url,
        status: a.status,
        ok: a.ok,
        bodySnippet: a.bodySnippet,
        error: a.error,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
