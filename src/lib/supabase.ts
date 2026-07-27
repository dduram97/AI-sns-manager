import "server-only";

import { createRequire } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

if (typeof window === "undefined") {
  // Next.js loads .env on the server; scripts (tick/seed) still need dotenv.
  try {
    createRequire(import.meta.url)("dotenv/config");
  } catch {
    // Bundled server runtime may already have env; ignore.
  }
}

export type DatabaseClient = SupabaseClient;

export function createServiceClient(): DatabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
