import type {
  ActionJob,
  ActionType,
  ChannelType,
} from "../workers/types";

/**
 * Common input for every ChannelAdapter method.
 * Keep channel-agnostic so Blog → Naver / Threads / Instagram can swap.
 */
export interface ChannelActionInput {
  job: ActionJob;
  personId: string;
  channel: ChannelType;
  draftBody: string | null;
  targetRef: Record<string, unknown>;
}

export type ChannelActionResult =
  | {
      ok: true;
      externalRef?: string;
      /** Legacy: already-liked soft skip that still marked executed */
      skipped?: boolean;
      /** Ops exclusion — mark action_jobs.status = skipped | excluded */
      outcome?: "executed" | "skipped" | "not_available" | "excluded";
      reasonCode?: string;
      reasonMessage?: string;
    }
  | { ok: false; errorMessage: string };

/**
 * Channel Adapter contract (ARCHITECTURE_SPEC v2.0).
 * blog channel → NaverBlogAdapter (Playwright). Threads / Instagram TBD.
 */
export interface ChannelAdapter {
  readonly channel: ChannelType;

  visit(input: ChannelActionInput): Promise<ChannelActionResult>;
  like(input: ChannelActionInput): Promise<ChannelActionResult>;
  comment(input: ChannelActionInput): Promise<ChannelActionResult>;
  /** neighbor_request maps here; NaverBlogAdapter implements requestNeighbor() */
  follow(input: ChannelActionInput): Promise<ChannelActionResult>;
  sync(input?: ChannelActionInput): Promise<ChannelActionResult>;
}

/** Map ActionJob.action_type → ChannelAdapter method (no channel switch). */
export type AdapterMethod = "visit" | "like" | "comment" | "follow";

export const ACTION_METHOD_REGISTRY: Record<ActionType, AdapterMethod> = {
  visit: "visit",
  like: "like",
  comment: "comment",
  neighbor_request: "follow",
  threads_reply: "comment",
};

export function toChannelActionInput(job: ActionJob): ChannelActionInput {
  return {
    job,
    personId: job.person_id,
    channel: job.channel,
    draftBody: job.draft_body,
    targetRef: job.target_ref ?? {},
  };
}
