// Admin user management — create / list / update-role / reset-password / delete
// team members. All operations require the CALLER to be an authenticated admin.
//
// Request body: { action: string, ...params }
//   action "list"          -> {}                                      -> { users: [...] }
//   action "create"        -> { email, password, full_name, role }   -> { user }
//   action "updateRole"    -> { id, role }                           -> { ok }
//   action "resetPassword" -> { id, password }                       -> { ok }
//   action "delete"        -> { id }                                 -> { ok }
//
// Why an Edge Function: creating/deleting auth users needs the service_role
// key (auth.admin API), which must never reach the browser.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROLES = ["admin", "editor", "viewer"] as const;
type Role = (typeof ROLES)[number];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- Authenticate the caller from their bearer token ----------------------
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Missing Authorization header." }, 401);

    // User-scoped client: resolves the token to the calling user.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return json({ error: "Invalid or expired session." }, 401);

    // Service-role client: privileged DB + auth.admin operations.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // --- Authorize: caller must be an admin ----------------------------------
    const { data: callerProfile, error: profileErr } = await admin
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .maybeSingle();
    if (profileErr) throw new Error(`Profile lookup failed: ${profileErr.message}`);
    if (callerProfile?.role !== "admin") {
      return json({ error: "Only admins can manage users." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action : "";

    switch (action) {
      case "list": {
        // auth.admin.listUsers is paginated; merge with profiles for role/name.
        const all: any[] = [];
        let page = 1;
        // perPage max is 1000; loop just in case the team ever grows past that.
        while (true) {
          const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
          if (error) throw new Error(`listUsers failed: ${error.message}`);
          all.push(...data.users);
          if (data.users.length < 1000) break;
          page += 1;
        }

        const { data: profiles, error: pErr } = await admin
          .from("profiles")
          .select("id, full_name, role");
        if (pErr) throw new Error(`profiles select failed: ${pErr.message}`);
        const byId = new Map((profiles ?? []).map((p) => [p.id, p]));

        const users = all.map((u) => {
          const p = byId.get(u.id);
          return {
            id: u.id,
            email: u.email,
            full_name: p?.full_name ?? "",
            role: (p?.role as Role) ?? "viewer",
            last_sign_in_at: u.last_sign_in_at ?? null,
            created_at: u.created_at,
          };
        });
        // Newest first.
        users.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return json({ users });
      }

      case "create": {
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const full_name = typeof body.full_name === "string" ? body.full_name.trim() : "";
        const role: Role = ROLES.includes(body.role) ? body.role : "viewer";

        if (!email) return json({ error: "Email is required." }, 400);
        if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true, // skip the email verification step
          user_metadata: { full_name, role }, // read by the handle_new_user trigger
        });
        if (error) return json({ error: error.message }, 400);

        return json({
          user: { id: data.user.id, email: data.user.email, full_name, role },
        });
      }

      case "updateRole": {
        const id = typeof body.id === "string" ? body.id : "";
        const role: Role | "" = ROLES.includes(body.role) ? body.role : "";
        if (!id || !role) return json({ error: "id and a valid role are required." }, 400);

        // Don't let an admin demote themselves — avoids locking the org out.
        if (id === caller.id && role !== "admin") {
          return json({ error: "You can't change your own admin role." }, 400);
        }

        const { error } = await admin.from("profiles").update({ role }).eq("id", id);
        if (error) throw new Error(`Role update failed: ${error.message}`);
        // Keep user_metadata in sync (cosmetic, but avoids stale values).
        await admin.auth.admin.updateUserById(id, { user_metadata: { role } });
        return json({ ok: true });
      }

      case "resetPassword": {
        const id = typeof body.id === "string" ? body.id : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!id) return json({ error: "id is required." }, 400);
        if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

        const { error } = await admin.auth.admin.updateUserById(id, { password });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "delete": {
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return json({ error: "id is required." }, 400);
        if (id === caller.id) return json({ error: "You can't delete your own account." }, 400);

        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) return json({ error: error.message }, 400);
        // profiles row is removed automatically via ON DELETE CASCADE.
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin-users] FAILED:", message);
    return json({ error: message }, 500);
  }
});
