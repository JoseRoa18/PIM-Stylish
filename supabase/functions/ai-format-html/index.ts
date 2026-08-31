// Format a product description as clean HTML — WITHOUT changing the words.
//
// Thin HTTP wrapper over _shared/aiFormat.ts (the same formatter runs inside
// wix-push-product on EVERY push). Takes the description's content and
// returns it in the SinksDirect house style: a single bold headline (the
// PRODUCT NAME passed by the caller — never AI-picked), an empty
// <p>&nbsp;</p> separator, then plain paragraphs. Only typographical repairs
// are allowed; the word-level validator rejects any rewording.
//
// Body: { text: string, headline?: string }  →  { ok, html, fixes: string[] }
// Caller must be an authenticated admin or editor.
// Required secrets: GEMINI_API_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { formatDescription } from "../_shared/aiFormat.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    if (!GEMINI_KEY) return json({ error: "GEMINI_API_KEY secret is not set." }, 500);

    // --- caller must be an authenticated admin or editor --------------------
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Missing Authorization header." }, 401);
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return json({ error: "Invalid or expired session." }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: profile } = await admin.from("profiles").select("role").eq("id", caller.id).maybeSingle();
    if (!["admin", "editor"].includes(profile?.role ?? "")) {
      return json({ error: "Only admins and editors can use this." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text : "";
    const headline = typeof body.headline === "string" ? body.headline : "";
    if (!text.trim()) return json({ error: "text is required" }, 400);

    const result = await formatDescription(GEMINI_KEY, text, headline);
    if (!result) return json({ error: "The AI kept altering the wording — nothing was changed." }, 422);
    return json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai-format-html] FAILED:", message);
    return json({ error: message }, 500);
  }
});
