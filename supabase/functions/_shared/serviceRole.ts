// Is this bearer a service-role key? Proven by what it can do (GoTrue's
// admin listing needs one) rather than by matching the runtime's own
// SUPABASE_SERVICE_ROLE_KEY — that copy is not always the key the .env files
// and other callers carry (seen 2026-09-25). Function-to-function calls
// inside the runtime still take the fast path (same string).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// The role claim of a JWT, read without a signature check — it only decides
// whether the admin probe is worth a round trip.
export function claimRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(b64)).role ?? null;
  } catch {
    return null;
  }
}

export async function isServiceRole(supabaseUrl: string, bearer: string, runtimeKey: string): Promise<boolean> {
  if (!bearer) return false;
  if (bearer === runtimeKey) return true;
  if (claimRole(bearer) !== "service_role" && !bearer.startsWith("sb_secret_")) return false;
  const { error } = await createClient(supabaseUrl, bearer).auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}
