import { NextResponse } from "next/server";
import { fetchNaverBlogComments } from "@/lib/naverBlogInboundApi";

export const dynamic = "force-dynamic";

/**
 * BFF: Node-side proxy to Naver commentbox API (avoids browser CORS).
 * POST body: { blogId, logNo, cookie?, referer?, pageSize? }
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      blogId?: string;
      logNo?: string;
      cookie?: string;
      referer?: string;
      pageSize?: number;
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
    const result = await fetchNaverBlogComments({
      blogId,
      logNo,
      cookie: String(body.cookie ?? ""),
      referer,
      pageSize: body.pageSize,
    });
    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      url: result.url,
      method: result.method,
      query: result.query,
      requestHeaders: result.requestHeaders,
      cookie: result.cookie,
      referer: result.referer,
      bodySnippet: result.bodySnippet,
      json: result.json,
      jsonParseOk: result.jsonParseOk,
      error: result.error,
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
