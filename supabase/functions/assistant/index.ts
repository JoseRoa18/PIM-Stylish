// Stylish PIM — the in-app assistant (the Assistant page and panel).
//
// User, 2026-11-11: "¿podemos conectar alguna IA que entienda la app y sepa
// exactamente cómo funciona y pedirle cosas por chat?" — "Hagamos lo del
// asistente"; then "Haz todo eso!" to the list of improvements.
//
// What it is: Claude answers from the PIM's own documentation
// (assistant_knowledge: CLAUDE.md from "## Architecture" on, cut into pieces
// it opens as a question needs them, and the tables it may read —
// scripts/sync-assistant-knowledge.mjs) and looks live data up with its
// tools (_shared/assistantTools.js). Every lookup is a read carrying the
// SESSION OF THE PERSON ASKING, so the database's own rules decide what comes
// back: the assistant sees what that person may see, never more.
//
// IT WRITES NOTHING TO THE PIM'S DATA. A change it is asked for is only
// PREPARED (a row in assistant_actions and a card on the page): the person
// confirms it there, and the page makes it through the app's own save, with
// that person's permissions. What this function writes: its own tables
// (assistant_chats / _turns / _actions / _knowledge) and two settings it
// owns (app_settings 'assistant_briefing', 'assistant_warm').
//
// This file: who is calling, the conversation's storage and the stream to
// the page. What the model is told and the question's loop:
// _shared/assistantTurn.js.
//
// POST { message, chat_id?, page?, attachments? } → a text/event-stream:
//   { type: "chat", chat_id }                  the conversation (new or continued)
//   { type: "step" }                           the model starts (or restarts) writing
//   { type: "text", delta }                    answer text as it is written
//   { type: "retract" }                        drop the text since the last "step"
//   { type: "tool", id, label } / { type: "tool_done", id, ok }
//   { type: "action", action }                 a change prepared for the person to confirm
//   { type: "done", turn_id, cost_usd, … }     the answer is complete and saved
//   { type: "error", message }
//   page         { path, title } of the page the question was asked from
//   attachments  [{ kind: "image", name, media_type, data } | { kind: "table", name, text }]
//
// POST { mode } → JSON, for the cron (x-cron-secret), an admin or the
// maintenance scripts (service role):
//   "warm"        keeps the cached beginning alive while someone asked in the
//                 last 3 hours (cron assistant-warm; an idle day costs nothing)
//   "briefing"    builds the Dashboard's weekly briefing (cron assistant-briefing,
//                 Monday 7 AM Eastern; { cron: true } runs only at that hour)
//   "user_guide"  rewrites, for people who are not admins, the pieces of the
//                 guide that are new or changed ({ limit? } per call; the sync
//                 script calls it until nothing remains; { again: true } also
//                 judges once more the pieces that were left for admins only)
//
// The conversation lives on the server (assistant_chats.messages) and is
// replayed to the model exactly as it was produced: the model's own blocks
// must come back unchanged, and an identical beginning is what makes what it
// is always shown (≈ 26,000 tokens: instructions, tools, the guide's index,
// the tables) cost a twentieth of its price from the second question on
// (prompt caching, kept 1 hour).
//
// Who may use it: app_settings 'assistant' = { enabled, emails, model?,
// effort?, daily_limit_usd? }. Admins are answered from the developers'
// guide, everyone else from the user guide (_shared/assistantGuide.js). Every
// question is logged in assistant_turns with who asked and what it cost.
//
// Deployed with verify_jwt off (the caller is checked here); upload with it
// _shared/assistantTurn.js, assistantTools.js, assistantTables.js,
// assistantBriefing.js, assistantGuide.js, serviceRole.ts and what the tools
// import (promoCalendar.ts, completeness.js, listingHealth.js,
// priceAlignmentReport.js, alignmentSummary.js, wixSites.ts and theirs).
// Secrets: ANTHROPIC_API_KEY, CRON_SECRET.
import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { etToday } from "../_shared/promoCalendar.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { ASSISTANT_EFFORT, ASSISTANT_MODEL, assistantKnowledge, assistantQuestion, runAssistantTurn, usageCost, warmAssistant } from "../_shared/assistantTurn.js";
import { buildBriefing } from "../_shared/assistantBriefing.js";
import { guideIndexOf, hashOf, rewritePiece, USER_GUIDE_MODEL } from "../_shared/assistantGuide.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const DEFAULT_DAILY_LIMIT_USD = 5;
const MAX_QUESTION = 4000; // characters
const MAX_ATTACHMENTS = 3;
const MAX_IMAGE = 1_400_000; // base64 characters (≈ 1 MB)
const MAX_TABLE = 60_000; // characters
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const WARM_FOR_HOURS = 3;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// The knowledge of an audience, kept a few minutes per warm instance: what
// the model is always shown (the guide's index and the tables) and the
// guide's pieces, which its guide tools read in memory. Admins read the
// developers' guide; everyone else the user guide made from it.
type Audience = "admin" | "user";
type Knowledge = { text: string; guide: any[] };
const GUIDE_KEYS: Record<Audience, [string, string]> = { admin: ["guide", "guide_index"], user: ["guide_user", "guide_user_index"] };
const knowledgeCache = new Map<Audience, { at: number; value: Knowledge }>();
async function loadKnowledge(admin: any, audience: Audience): Promise<Knowledge> {
  const kept = knowledgeCache.get(audience);
  if (kept && Date.now() - kept.at < 5 * 60 * 1000) return kept.value;
  const [piecesKey, indexKey] = GUIDE_KEYS[audience];
  const { data, error } = await admin.from("assistant_knowledge").select("key, content").in("key", [piecesKey, indexKey, "database"]);
  if (error) throw new Error(`The assistant's knowledge could not be read: ${error.message}`);
  const row = (key: string) => data?.find((r: any) => r.key === key)?.content;
  let guide: any[] = [];
  try {
    guide = JSON.parse(row(piecesKey) ?? "[]");
  } catch { /* not the pieces: treated as missing */ }
  if (!guide.length || !row(indexKey) || !row("database")) {
    throw new Error(audience === "admin"
      ? "The assistant's knowledge is not loaded yet (run scripts/sync-assistant-knowledge.mjs)."
      : "The assistant's guide for the team is not ready yet. Ask an administrator.");
  }
  const value = { text: assistantKnowledge(row(indexKey), row("database")), guide };
  knowledgeCache.set(audience, { at: Date.now(), value });
  return value;
}

const nowEastern = () => new Date().toLocaleString("en-US", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const easternHour = () => Number(new Date().toLocaleString("en-US", { timeZone: "America/Toronto", hour: "numeric", hour12: false })) % 24;
const oneLine = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

/** A failure in words the person can act on. */
function explain(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "The assistant is busy right now. Try again in a minute.";
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "The assistant's key was refused by Anthropic. Tell an administrator.";
  if (err instanceof Anthropic.APIError) return `Claude answered with an error (${err.status ?? "no connection"}): ${String(err.message).slice(0, 300)}`;
  return String((err as Error)?.message ?? err).slice(0, 300);
}

/** What the person attached, checked: images (base64) and tables (text). */
function readAttachments(raw: unknown): any[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("The attachments are not a list.");
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} files per question.`);
  return raw.map((a: any) => {
    const name = oneLine(a?.name, 120) || "file";
    if (a?.kind === "image") {
      if (!IMAGE_TYPES.includes(a.media_type)) throw new Error(`${name}: only JPEG, PNG or WebP images.`);
      const data = String(a.data ?? "");
      if (!data || data.length > MAX_IMAGE || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error(`${name}: the image is too large (1 MB at most once reduced).`);
      return { kind: "image", name, media_type: a.media_type, data };
    }
    if (a?.kind === "table") {
      const text = String(a.text ?? "");
      if (!text.trim() || text.length > MAX_TABLE) throw new Error(`${name}: the table is empty or too long (${MAX_TABLE.toLocaleString("en-US")} characters at most).`);
      return { kind: "table", name, text };
    }
    throw new Error(`${name}: only images and tables can be attached.`);
  });
}

// ── Maintenance modes (cron, an admin, the scripts) ─────────────────────────
async function mayMaintain(req: Request, admin: any): Promise<boolean> {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) return true;
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return false;
  if (await isServiceRole(SUPABASE_URL, bearer, SERVICE_KEY)) return true;
  const { data: { user } } = await createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } }).auth.getUser(bearer);
  if (!user) return false;
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  return profile?.role === "admin";
}

async function warm(admin: any, anthropic: Anthropic, setting: any) {
  const since = new Date(Date.now() - WARM_FOR_HOURS * 3600 * 1000).toISOString();
  const { data } = await admin.from("assistant_turns").select("audience").gte("created_at", since);
  const audiences = [...new Set((data ?? []).map((r: any) => (r.audience === "user" ? "user" : "admin")))] as Audience[];
  const warmed: any[] = [];
  for (const audience of audiences) {
    try {
      const knowledge = await loadKnowledge(admin, audience);
      const spent = await warmAssistant({ anthropic, model: String(setting.model ?? ASSISTANT_MODEL), effort: String(setting.effort ?? ASSISTANT_EFFORT), knowledge: knowledge.text });
      warmed.push({ audience, was_warm: spent.read > 0, read: spent.read, written: spent.write1h + spent.write5m, usd: Math.round(spent.cost * 1e5) / 1e5 });
    } catch (err) {
      warmed.push({ audience, error: explain(err) });
    }
  }
  const report = { at: new Date().toISOString(), asked_in_the_last_hours: WARM_FOR_HOURS, warmed };
  if (warmed.length) await admin.from("app_settings").upsert({ key: "assistant_warm", value: report, updated_at: report.at }, { onConflict: "key" });
  return report;
}

async function userGuide(admin: any, anthropic: Anthropic, limit: number, again: boolean) {
  const { data, error } = await admin.from("assistant_knowledge").select("key, content").in("key", ["guide", "guide_user_cache"]);
  if (error) throw new Error(error.message);
  const pieces: any[] = JSON.parse(data?.find((r: any) => r.key === "guide")?.content ?? "[]");
  if (!pieces.length) throw new Error("The guide is not loaded yet (run scripts/sync-assistant-knowledge.mjs).");
  const cache: Record<string, any> = JSON.parse(data?.find((r: any) => r.key === "guide_user_cache")?.content ?? "{}");
  // `again`: the pieces left for admins only are judged once more (after the rewriting instructions change).
  if (again) for (const key of Object.keys(cache)) if (cache[key]?.audience !== "all") delete cache[key];

  // A piece only some people may read never goes to the team's guide.
  const open = pieces.filter((p) => !p.only);
  const hashes = new Map<string, string>();
  for (const p of open) hashes.set(p.id, await hashOf(`${p.section}\n${p.text}`));
  const todo = open.filter((p) => !cache[hashes.get(p.id)!]).slice(0, limit);

  let cost = 0;
  const failed: string[] = [];
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async (piece) => {
      try {
        const out = await rewritePiece({ anthropic, piece });
        cost += usageCost(out.usage, USER_GUIDE_MODEL).cost;
        cache[hashes.get(piece.id)!] = out.audience === "all" ? { audience: "all", lead: out.lead, text: out.text } : { audience: "admin" };
      } catch (err) {
        failed.push(`${piece.id}: ${explain(err)}`);
      }
    }));
  }

  // The team's guide: the rewritten pieces, in the guide's own order; the
  // cache keeps only what the guide still holds.
  const live = new Set(hashes.values());
  for (const key of Object.keys(cache)) if (!live.has(key)) delete cache[key];
  const userPieces = open
    .filter((p) => cache[hashes.get(p.id)!]?.audience === "all")
    .map((p) => ({ id: p.id, section: p.section, lead: cache[hashes.get(p.id)!].lead, text: cache[hashes.get(p.id)!].text }));
  const remaining = open.filter((p) => !cache[hashes.get(p.id)!]).length;
  const at = new Date().toISOString();
  const rows = [{ key: "guide_user_cache", content: JSON.stringify(cache), updated_at: at }];
  // The guide itself is replaced only once it is whole: until then the team keeps the one it had.
  if (!remaining) {
    rows.push({ key: "guide_user", content: JSON.stringify(userPieces), updated_at: at });
    rows.push({ key: "guide_user_index", content: guideIndexOf(userPieces), updated_at: at });
    knowledgeCache.delete("user");
  }
  const { error: saveError } = await admin.from("assistant_knowledge").upsert(rows, { onConflict: "key" });
  if (saveError) throw new Error(saveError.message);
  return { pieces: open.length, rewritten: todo.length - failed.length, remaining, in_the_team_guide: userPieces.length, admins_only: open.length - userPieces.length - remaining, usd: Math.round(cost * 1e4) / 1e4, model: USER_GUIDE_MODEL, ...(failed.length ? { failed } : {}) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "The assistant is not configured (ANTHROPIC_API_KEY is missing)." }, 500);
  const anthropic = new Anthropic({ apiKey });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: any = {};
  try {
    body = await req.json();
  } catch { /* empty body */ }

  // ── Maintenance ──
  if (body.mode) {
    if (!(await mayMaintain(req, admin))) return json({ error: "Not allowed." }, 401);
    try {
      const { data: settingRow } = await admin.from("app_settings").select("value").eq("key", "assistant").maybeSingle();
      const setting = settingRow?.value ?? {};
      if (body.mode === "warm") {
        if (setting.enabled !== true) return json({ skipped: "the assistant is off" });
        return json(await warm(admin, anthropic, setting));
      }
      if (body.mode === "briefing") {
        if (body.cron && easternHour() !== 7) return json({ skipped: "not 7 AM Eastern" });
        const briefing = await buildBriefing({ url: SUPABASE_URL, apikey: SERVICE_KEY, token: SERVICE_KEY, today: etToday() });
        const { error } = await admin.from("app_settings").upsert({ key: "assistant_briefing", value: briefing, updated_at: briefing.generated_at }, { onConflict: "key" });
        if (error) throw new Error(error.message);
        return json(briefing);
      }
      if (body.mode === "user_guide") return json(await userGuide(admin, anthropic, Math.min(Math.max(Number(body.limit) || 36, 1), 60), body.again === true));
      return json({ error: `Unknown mode "${body.mode}".` }, 400);
    } catch (err) {
      return json({ error: explain(err) }, 500);
    }
  }

  // ── A question ── Who is asking: a signed-in person on the assistant's list.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first." }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user } } = await userClient.auth.getUser(token);
  if (!user) return json({ error: "Your session has expired. Sign in again." }, 401);

  const [{ data: settingRows }, { data: profile }] = await Promise.all([
    admin.from("app_settings").select("key, value").in("key", ["assistant", "scorecard_company_viewers"]),
    admin.from("profiles").select("email, full_name, role").eq("id", user.id).maybeSingle(),
  ]);
  const setting = settingRows?.find((r: any) => r.key === "assistant")?.value ?? {};
  const email = String(profile?.email ?? user.email ?? "").trim().toLowerCase();
  const lower = (list: unknown) => (Array.isArray(list) ? list : []).map((e) => String(e).trim().toLowerCase());
  if (setting.enabled !== true || !email || !lower(setting.emails).includes(email)) return json({ error: "The assistant is not available for your account yet." }, 403);
  const role = String(profile?.role ?? "viewer");
  const audience: Audience = role === "admin" ? "admin" : "user";
  // The restricted topics this person may read about (the guide's pieces marked `only`).
  const groups = lower(settingRows?.find((r: any) => r.key === "scorecard_company_viewers")?.value?.emails).includes(email) ? ["company"] : [];

  const question = String(body.message ?? "").trim();
  if (!question) return json({ error: "Write a question." }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `The question is too long (${question.length} characters; ${MAX_QUESTION} at most).` }, 400);
  let attachments: any[];
  try {
    attachments = readAttachments(body.attachments);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }
  const page = body.page?.path ? `${oneLine(body.page.title, 80) || "a page"} — ${oneLine(body.page.path, 160)}` : null;

  // What the last 24 hours cost, against the limit.
  const limitUsd = Number(setting.daily_limit_usd ?? DEFAULT_DAILY_LIMIT_USD);
  const { data: recent } = await admin.from("assistant_turns").select("cost_usd").gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const spent = (recent ?? []).reduce((s: number, r: any) => s + Number(r.cost_usd || 0), 0);
  if (spent >= limitUsd) return json({ error: `The assistant reached its limit for 24 hours ($${limitUsd.toFixed(2)}). It will answer again later.` }, 429);

  // The conversation: continued (it must be this person's) or new.
  let chat: { id: string; messages: any[] };
  let outcomes: any[] = [];
  if (body.chat_id) {
    const { data } = await admin.from("assistant_chats").select("id, user_id, messages").eq("id", String(body.chat_id)).maybeSingle();
    if (!data || data.user_id !== user.id) return json({ error: "That conversation was not found." }, 404);
    chat = { id: data.id, messages: Array.isArray(data.messages) ? data.messages : [] };
    // What the person decided about the changes prepared earlier, not told to the model yet.
    const { data: decided } = await admin.from("assistant_actions").select("id, summary, status, result").eq("chat_id", chat.id).eq("reported", false).neq("status", "proposed").order("created_at");
    outcomes = decided ?? [];
  } else {
    const { data, error } = await admin.from("assistant_chats").insert({ user_id: user.id, title: question.replace(/\s+/g, " ").slice(0, 80) }).select("id").single();
    if (error || !data) return json({ error: "The conversation could not be started." }, 500);
    chat = { id: data.id, messages: [] };
  }

  let knowledge: Knowledge;
  try {
    knowledge = await loadKnowledge(admin, audience);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }

  const outcomeLine = (a: any) => `"${a.summary}" — ${a.status === "done" ? "the person confirmed it and it was made" : a.status === "cancelled" ? "the person cancelled it; nothing changed" : "it failed and nothing changed"}${a.result ? ` (${oneLine(a.result, 300)})` : ""}`;
  const userMessage = assistantQuestion({
    now: nowEastern(),
    who: `${profile?.full_name || email} (${email}) — role: ${role}`,
    question,
    page,
    outcomes: outcomes.map(outcomeLine),
    attachments,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false; // the page went away; the answer is still finished and saved
        }
      };
      const send = (event: Record<string, unknown>) => write(`data: ${JSON.stringify(event)}\n\n`);
      const ping = setInterval(() => write(": keep-alive\n\n"), 15000);
      const started = Date.now();
      const prepared: string[] = [];

      send({ type: "chat", chat_id: chat.id });
      const turn = await runAssistantTurn({
        anthropic,
        isApiError: (err: unknown) => err instanceof Anthropic.APIError,
        model: String(setting.model ?? ASSISTANT_MODEL),
        effort: String(setting.effort ?? ASSISTANT_EFFORT),
        knowledge: knowledge.text,
        history: chat.messages,
        userMessage,
        ctx: {
          url: SUPABASE_URL,
          apikey: ANON_KEY,
          token,
          today: etToday(),
          guide: knowledge.guide,
          db: userClient,
          role,
          groups,
          // A change the assistant PREPARES: kept, and shown to the person as a
          // card. Nothing is changed here — they confirm it on the page.
          saveAction: async (proposal: { kind: string; summary: string; payload: unknown }) => {
            const { data, error } = await admin.from("assistant_actions").insert({ chat_id: chat.id, user_id: user.id, kind: proposal.kind, summary: proposal.summary, payload: proposal.payload }).select("id").single();
            if (error || !data) throw new Error("The change could not be prepared.");
            prepared.push(data.id);
            send({ type: "action", action: { id: data.id, kind: proposal.kind, summary: proposal.summary, payload: proposal.payload, status: "proposed" } });
            return data.id;
          },
        },
        send,
      });
      const failure = turn.error ? explain(turn.error) : null;

      // Saved: the conversation only when the answer is whole, the usage always.
      try {
        if (!failure && turn.produced.length) {
          await admin.from("assistant_chats").update({ messages: [...chat.messages, userMessage, ...turn.produced], updated_at: new Date().toISOString() }).eq("id", chat.id);
          if (outcomes.length) await admin.from("assistant_actions").update({ reported: true }).in("id", outcomes.map((a) => a.id));
        }
        const { data: row } = await admin.from("assistant_turns").insert({
          chat_id: chat.id,
          user_id: user.id,
          user_email: email,
          question,
          answer: turn.answer || null,
          tools: turn.tools,
          model: turn.model,
          stop_reason: turn.stopReason || null,
          input_tokens: turn.usage.input,
          cache_read_tokens: turn.usage.read,
          cache_write_tokens: turn.usage.write5m + turn.usage.write1h,
          output_tokens: turn.usage.output,
          cost_usd: turn.usage.cost,
          duration_ms: Date.now() - started,
          error: failure,
          page,
          attachments: attachments.length ? attachments.map((a) => ({ kind: a.kind, name: a.name })) : null,
          audience,
        }).select("id").single();
        if (row?.id && prepared.length) await admin.from("assistant_actions").update({ turn_id: row.id }).in("id", prepared);
        if (failure) send({ type: "error", message: failure, turn_id: row?.id ?? null });
        else send({ type: "done", turn_id: row?.id ?? null, cost_usd: turn.usage.cost, lookups: turn.tools.length, stop_reason: turn.stopReason, model: turn.model });
      } catch (err) {
        send({ type: "error", message: failure ?? `The answer could not be saved: ${(err as Error).message}` });
      }
      clearInterval(ping);
      try {
        controller.close();
      } catch { /* already closed */ }
    },
  });

  return new Response(stream, { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
});
