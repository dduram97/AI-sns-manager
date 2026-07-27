/**
 * Worker Supabase client (service role).
 * Mirrors app createServiceClient without Next.js `server-only`.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type DatabaseClient = SupabaseClient;

export function createServiceClient(): DatabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (load repo root .env)",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
