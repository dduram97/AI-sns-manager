/**
 * Outcome daily — ensure row exists for Goal feedback on next Decision tick.
 */

import type { Repositories } from "../repositories/index";
import type { OutcomeDaily } from "./types";

export async function touchOutcome(repos: Repositories): Promise<OutcomeDaily> {
  return repos.ensureOutcomeToday();
}
