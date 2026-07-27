/**
 * Delete verify-tagged Persons only (cascade workflows / jobs / approvals).
 * Operational persons (no discover_meta.verify / no [verify: prefix) are never deleted.
 *
 * Usage:
 *   npm run verify:loop:clean
 *   npm run verify:loop:clean -- --run <test_run_id>
 */

import { createServiceClient } from "../src/lib/supabase";
import {
  isVerifyPersonMeta,
  testRunIdFromMeta,
  VERIFY_META,
} from "./verifyMeta";

export type CleanupResult = {
  deletedPersonIds: string[];
  skippedNonVerify: number;
  testRunIdFilter: string | null;
};

function isVerifyFixture(row: {
  display_name?: string | null;
  discover_meta?: unknown;
}): boolean {
  const meta = (row.discover_meta ?? {}) as Record<string, unknown>;
  if (isVerifyPersonMeta(meta)) return true;
  return String(row.display_name ?? "").startsWith("[verify:");
}

export async function cleanupVerifyPersons(opts?: {
  testRunId?: string | null;
}): Promise<CleanupResult> {
  const db = createServiceClient();
  const testRunIdFilter = opts?.testRunId?.trim() || null;

  const { data: rows, error } = await db
    .from("persons")
    .select("id, display_name, discover_meta");
  if (error) throw error;

  const toDelete: string[] = [];
  let skippedNonVerify = 0;

  for (const row of rows ?? []) {
    if (!isVerifyFixture(row)) {
      skippedNonVerify += 1;
      continue;
    }

    if (testRunIdFilter) {
      const meta = (row.discover_meta ?? {}) as Record<string, unknown>;
      const runId = testRunIdFromMeta(meta);
      const nameHasRun = String(row.display_name ?? "").includes(
        testRunIdFilter,
      );
      if (runId !== testRunIdFilter && !nameHasRun) continue;
    }

    toDelete.push(String(row.id));
  }

  if (toDelete.length === 0) {
    return { deletedPersonIds: [], skippedNonVerify, testRunIdFilter };
  }

  // Break circular FK persons.active_workflow_id → workflows
  const { error: clearErr } = await db
    .from("persons")
    .update({ active_workflow_id: null })
    .in("id", toDelete);
  if (clearErr) throw clearErr;

  await db.from("perception_events").delete().in("person_id", toDelete);
  await db.from("activity_items").delete().in("person_id", toDelete);
  await db.from("decision_records").delete().in("person_id", toDelete);

  const { error: delErr } = await db
    .from("persons")
    .delete()
    .in("id", toDelete);
  if (delErr) throw delErr;

  return {
    deletedPersonIds: toDelete,
    skippedNonVerify,
    testRunIdFilter,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let testRunId: string | null = null;
  const runIdx = args.findIndex((a) => a === "--run" || a === "--test-run-id");
  if (runIdx >= 0 && args[runIdx + 1]) {
    testRunId = args[runIdx + 1]!;
  }

  console.log(
    testRunId
      ? `Cleaning verify persons for test_run_id=${testRunId} …`
      : `Cleaning ALL verify-tagged persons (discover_meta.${VERIFY_META.flag}=true) …`,
  );

  const result = await cleanupVerifyPersons({ testRunId });
  console.log(
    `Deleted ${result.deletedPersonIds.length} verify person(s); skipped ${result.skippedNonVerify} non-verify.`,
  );
  for (const id of result.deletedPersonIds) {
    console.log(`  - ${id}`);
  }
}

const isDirect =
  process.argv[1]?.includes("verify-cleanup") ||
  process.argv[1]?.endsWith("verify-cleanup.ts");

if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
