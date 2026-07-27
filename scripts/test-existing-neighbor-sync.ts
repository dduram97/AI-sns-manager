/**
 * One-shot existing-neighbor sync test (CDP + DB).
 * Usage: node --import tsx scripts/test-existing-neighbor-sync.ts
 */
import { config } from "dotenv";
config({ path: ".env" });

async function main() {
  const blogId = process.env.NAVER_BLOG_ID;
  console.log("=== existing neighbor sync test ===");
  console.log("NAVER_BLOG_ID=", blogId);
  console.log("USE_CDP=", process.env.USE_CDP);
  console.log("CDP_URL=", process.env.CDP_URL);

  const {
    fetchExistingNeighborsFromNaver,
    upsertExistingNeighborsBatch,
    finalizeExistingNeighborSync,
    EXISTING_NEIGHBOR_UPSERT_BATCH,
  } = await import("../src/services/neighborExistingSyncService");

  const fetched = await fetchExistingNeighborsFromNaver();
  console.log("\n=== fetch summary ===");
  console.log("ok=", fetched.ok);
  console.log("message=", fetched.message);
  console.log("ownBlogId=", fetched.ownBlogId);
  console.log("extracted=", fetched.neighbors.length);
  console.log("checklist=", fetched.diagnostics?.checklist);
  console.log("pageAccess=", fetched.diagnostics?.pageAccessSummary);

  if (!fetched.ok || fetched.neighbors.length === 0) {
    console.log("\nSTOP: nothing to save");
    process.exit(fetched.ok && fetched.neighbors.length === 0 ? 0 : 1);
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (
    let i = 0;
    i < fetched.neighbors.length;
    i += EXISTING_NEIGHBOR_UPSERT_BATCH
  ) {
    const chunk = fetched.neighbors.slice(
      i,
      i + EXISTING_NEIGHBOR_UPSERT_BATCH,
    );
    const batch = await upsertExistingNeighborsBatch(chunk);
    added += batch.added;
    updated += batch.updated;
    skipped += batch.skipped;
    errors.push(...batch.errors);
    console.log(
      `[neighbor-sync] save progress ${Math.min(i + chunk.length, fetched.neighbors.length)}/${fetched.neighbors.length} added=${added} updated=${updated}`,
    );
  }

  const summary = await finalizeExistingNeighborSync({
    ownBlogId: fetched.ownBlogId,
    total: fetched.neighbors.length,
    added,
    updated,
    skipped,
    errors,
  });

  console.log("\n=== save result ===");
  console.log("[neighbor-sync] save result:", {
    total: summary.total,
    added: summary.added,
    updated: summary.updated,
    skipped: summary.skipped,
    errors: summary.errors.length,
    message: summary.message,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
