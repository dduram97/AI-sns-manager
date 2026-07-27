/**
 * CDP Worker — phase 2-1 Naver session check entry.
 * Usage: npm run check:naver
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCdpUrl } from "./browser/cdpClient";
import { checkNaverSession } from "./naver/naverSessionChecker";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, "worker", ".env"), override: true });

async function main() {
  console.info("[cdp-worker] check:naver start");
  console.info(`[cdp-worker] CDP_URL=${resolveCdpUrl()}`);

  const result = await checkNaverSession();

  console.info("[cdp-worker] check:naver summary", {
    ok: result.ok,
    loggedIn: result.loggedIn,
    url: result.url,
    title: result.title,
  });

  if (!result.ok) {
    process.exitCode = 1;
    console.error("[cdp-worker] check:naver FAILED");
    return;
  }

  console.info("[cdp-worker] check:naver OK");
}

main().catch((err) => {
  console.error(
    "[cdp-worker] check:naver fatal",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
