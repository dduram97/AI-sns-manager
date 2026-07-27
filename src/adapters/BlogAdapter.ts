import type {
  ChannelActionInput,
  ChannelActionResult,
  ChannelAdapter,
} from "./types";

/**
 * Mock Blog channel adapter (legacy reference).
 * Default registry uses NaverBlogAdapter (Playwright).
 */
export class BlogAdapter implements ChannelAdapter {
  readonly channel = "blog" as const;

  async visit(_input: ChannelActionInput): Promise<ChannelActionResult> {
    console.log("Visit executed (mock)");
    return { ok: true };
  }

  async like(_input: ChannelActionInput): Promise<ChannelActionResult> {
    console.log("Like executed (mock)");
    return { ok: true };
  }

  async comment(input: ChannelActionInput): Promise<ChannelActionResult> {
    console.log("Comment executed (mock)");
    if (input.draftBody) {
      console.log(`Comment draft: ${input.draftBody.slice(0, 120)}`);
    }
    return { ok: true };
  }

  async follow(_input: ChannelActionInput): Promise<ChannelActionResult> {
    console.log("Follow executed (mock)");
    return { ok: true };
  }

  async sync(_input?: ChannelActionInput): Promise<ChannelActionResult> {
    console.log("Sync executed (mock)");
    return { ok: true };
  }
}
