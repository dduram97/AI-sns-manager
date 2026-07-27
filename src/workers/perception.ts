/**
 * Perception — loads unprocessed PerceptionEvents from Postgres.
 * Channel ingest writes into perception_events; tick only consumes them.
 */

import type { Repositories } from "../repositories/index";
import type { PerceptionEvent } from "./types";

export async function loadUnprocessedPerceptions(
  repos: Repositories,
): Promise<PerceptionEvent[]> {
  return repos.listUnprocessedPerceptions();
}

export async function markPerceptionsProcessed(
  repos: Repositories,
  ids: string[],
): Promise<void> {
  await repos.markPerceptionsProcessed(ids);
}
