// Format a product description as clean HTML — WITHOUT changing the words.
//
// Takes the description's current content (plain text or messy HTML) and
// returns the same text in the SinksDirect house style (sampled 2026-08-31
// from 12 live products): a single bold headline (the PRODUCT NAME, injected
// by code — never AI-picked), an empty <p>&nbsp;</p> separator, then plain
// paragraphs — no other bolds, no lists (lists would eat the commas). The
// body's words are
// GUARANTEED untouched: the tag-stripped output must match the tag-stripped
// input exactly, or the response is rejected (one retry, then 422) — the
// model can only add markup, never rewrite.
//
// Body: { text: string, headline?: string }  →  { ok, html, fixes: string[] }
// `headline` (the product's name, from PIM data) is prepended by CODE as the
// single bold title paragraph — the AI never chooses or writes the headline.
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
    // Tag-stripping turns "<strong>word</strong>." into "word ." — spacing
    // around punctuation is layout, not wording, so it never fails the match.
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();

const PROMPT = `You are a formatter and proofreader. Reformat the product description below as HTML:
- Split the prose into plain <p> paragraphs at natural topic breaks, with an empty <p>&nbsp;</p> between paragraphs.
- Fix ONLY obvious typographical errors: missing or extra letters, doubled words, stray or misplaced punctuation, wrong capitalization at sentence starts.
- NO bold, NO lists, NO headings. Allowed tags ONLY: p, br.
CRITICAL: never reword, rephrase, reorder or summarize. Do not swap a word for a different word — only repair misspelled ones. Every sentence keeps its exact wording. Output ONLY the HTML, no code fences, no commentary.

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

// ---------- verbatim-except-typos validator ---------------------------------
// The output may differ from the input ONLY by typographical repairs: each
// changed word must be a small edit of the original (Levenshtein <= 2, or a
// join/split like "bath room" -> "bathroom"), doubled words may collapse,
// and the total number of repaired words is capped. Substituting a word for
// a DIFFERENT word ("good" -> "great") fails the distance test and rejects
// the whole response.

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function onlyTypoFixes(src: string, out: string): { ok: boolean; fixes: string[] } {
  if (src === out) return { ok: true, fixes: [] };
  const A = src.split(" ");
  const B = out.split(" ");
  // LCS over words (case/punctuation-insensitive key) to align the texts.
  const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return { ok: false, fixes: [] };
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = key(A[i]) === key(B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const fixes: string[] = [];
  let i = 0, j = 0;
  let repaired = 0;
  const fail = { ok: false, fixes: [] as string[] };
  const repair = (label: string) => { fixes.push(label); repaired++; };
  while (i < n || j < m) {
    if (i < n && j < m && key(A[i]) === key(B[j])) {
      if (A[i] !== B[j]) {
        // same word, different case/punctuation — typo-level repair
        if (levenshtein(A[i], B[j]) > 2) return fail;
        repair(`${A[i]} -> ${B[j]}`);
      }
      i++; j++;
      continue;
    }
    const canDelete = i < n && (j >= m || dp[i + 1][j] === dp[i][j]);
    const canInsert = j < m && (i >= n || dp[i][j + 1] === dp[i][j]);
    if (canDelete && canInsert && i < n && j < m) {
      // substitution slot: must be a spelling repair, a join, or a split
      const a = A[i], b = B[j];
      if (levenshtein(a, b) <= 2) { repair(`${a} -> ${b}`); i++; j++; continue; }
      if (i + 1 < n && levenshtein(A[i] + A[i + 1], b) <= 1) { repair(`${a} ${A[i + 1]} -> ${b}`); i += 2; j++; continue; }
      if (j + 1 < m && levenshtein(a, B[j] + B[j + 1]) <= 1) { repair(`${a} -> ${b} ${B[j + 1]}`); i++; j += 2; continue; }
      return fail;
    }
    if (canDelete) {
      // deletion allowed only for a doubled word ("the the" -> "the")
      if (i > 0 && key(A[i]) === key(A[i - 1]) && key(A[i]) !== "") { repair(`${A[i - 1]} ${A[i]} -> ${A[i - 1]}`); i++; continue; }
      return fail;
    }
    return fail; // insertion of a new word = rewording
  }
  const cap = Math.max(4, Math.round(A.length * 0.06));
  return repaired <= cap ? { ok: true, fixes } : fail;
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
    // The bold headline is NOT the AI's call: it comes from product data
    // (the product's name), injected here after validation — the AI only
    // lays out the body, verbatim.
    const headline = typeof body.headline === "string" ? body.headline.trim() : "";
    const escapeHtml = (v: string) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const headlineHtml = headline
      ? `<p><strong>${escapeHtml(headline)}</strong></p>
<p>&nbsp;</p>
`
      : "";
    const source = normalize(text);
    if (!source) return json({ error: "text is required" }, 400);
    if (source.length > 8000) return json({ error: "Text too long (8000 chars max)." }, 400);

    for (let attempt = 0; attempt < 2; attempt++) {
      const html = await gemini(GEMINI_KEY, source, attempt > 0);
      const verdict = onlyTypoFixes(source, normalize(html));
      if (verdict.ok) return json({ ok: true, html: headlineHtml + html, fixes: verdict.fixes });
    }
    return json({ error: "The AI kept altering the wording — nothing was changed." }, 422);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai-format-html] FAILED:", message);
    return json({ error: message }, 500);
  }
});
