// Format a product description as clean HTML — WITHOUT changing the words.
//
// Takes the description's current content (plain text or messy HTML) and
// returns the same text with tasteful structure: paragraphs and <strong> on
// the key product terms (no lists — they would eat the commas). The words are
// GUARANTEED untouched: the tag-stripped output must match the tag-stripped
// input exactly, or the response is rejected (one retry, then 422) — the
// model can only add markup, never rewrite.
//
// Body: { text: string }  →  { ok, html }
// Caller must be an authenticated admin or editor.
// Required secrets: GEMINI_API_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

const normalize = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

const PROMPT = `You are a formatter. Reformat the product description below as clean HTML for an e-commerce page:
- Split the prose into <p> paragraphs at natural topic breaks.
- Bold (<strong>) the genuinely important product terms: model names, materials, dimensions, finishes, standout features. Be tasteful — a handful of bolds, not everywhere.
- Allowed tags ONLY: p, strong, em, br. Do NOT create lists — keep enumerations as prose, commas included.
CRITICAL: do NOT add, remove, reorder or reword ANY text. Every word, number and punctuation mark must appear exactly as given, in the same order. Output ONLY the HTML, no code fences, no commentary.

TEXT:
`;

async function gemini(apiKey: string, text: string, strict: boolean): Promise<string> {
  const body = {
    contents: [{ parts: [{ text: PROMPT + text + (strict ? "\n\nREMINDER: your previous attempt changed the wording. Copy the text VERBATIM — only add HTML tags." : "") }] }],
    generationConfig: { temperature: 0 },
  };
  const resp = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  let out: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  out = out.replace(/^```(?:html)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  // Cosmetic: no space between a closing tag and following punctuation.
  out = out.replace(/<\/(strong|em)>\s+([,.;:!?])/g, "</$1>$2");
  return out;
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
    const source = normalize(text);
    if (!source) return json({ error: "text is required" }, 400);
    if (source.length > 8000) return json({ error: "Text too long (8000 chars max)." }, 400);

    for (let attempt = 0; attempt < 2; attempt++) {
      const html = await gemini(GEMINI_KEY, source, attempt > 0);
      if (normalize(html) === source) return json({ ok: true, html });
    }
    return json({ error: "The AI kept altering the wording — nothing was changed." }, 422);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai-format-html] FAILED:", message);
    return json({ error: message }, 500);
  }
});
