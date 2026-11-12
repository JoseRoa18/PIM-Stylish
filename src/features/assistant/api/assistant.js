import { supabase } from '@/lib/supabase';
import { getAppSetting, saveAppSetting } from '@/features/settings/api/appSettings';

// The in-app assistant (20261111_assistant.sql, 20261111_assistant_more.sql,
// the `assistant` edge function). It reads the PIM with the permissions of
// the person asking and changes nothing by itself: a change it prepares is a
// card the person confirms (assistantActions.js), and an Excel file it
// prepares is a card the person downloads (lib/excelFile.js; the table is
// 20261112_assistant_files.sql). The conversation lives on
// the server: the page sends a question and shows what the function streams
// back.

const lower = (v) => String(v ?? '').trim().toLowerCase();

/**
 * app_settings 'assistant' = { enabled, emails, effort?, daily_limit_usd?, actions? }.
 * `actions` = { set_obsolete?: false, set_prices?: false }: a kind of change set to false is
 * not prepared from the chat. Read once per page load; `fresh` asks again.
 */
let settingPromise = null;
export function getAssistantSetting({ fresh = false } = {}) {
  if (!settingPromise || fresh) {
    settingPromise = getAppSetting('assistant', {}).catch((err) => {
      settingPromise = null;
      throw err;
    });
  }
  return settingPromise;
}

/** Saves the assistant's setting (admins; the database refuses anyone else). */
export async function saveAssistantSetting(value) {
  await saveAppSetting('assistant', value);
  settingPromise = Promise.resolve(value);
}

/** Is this person on the assistant's list? (The function checks it again.) */
export const mayUseAssistant = (setting, email) => setting?.enabled === true && Boolean(lower(email)) && (setting.emails ?? []).map(lower).includes(lower(email));

/** This person's conversations, newest first. */
export async function listChats(limit = 40) {
  const { data, error } = await supabase.from('assistant_chats').select('id, title, updated_at').order('updated_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

/** A conversation's questions and answers (oldest first), the changes and the Excel files prepared in it. */
export async function loadChat(chatId) {
  const [turns, actions, files] = await Promise.all([
    supabase.from('assistant_turns').select('id, question, answer, tools, cost_usd, error, rating, rating_note, attachments, created_at').eq('chat_id', chatId).order('id', { ascending: true }),
    supabase.from('assistant_actions').select('id, turn_id, kind, summary, payload, status, result, created_at, claimed_at').eq('chat_id', chatId).order('created_at', { ascending: true }),
    supabase.from('assistant_files').select('id, turn_id, kind, title, spec, summary').eq('chat_id', chatId).order('created_at', { ascending: true }),
  ]);
  if (turns.error) throw turns.error;
  if (actions.error) throw actions.error;
  if (files.error) throw files.error;
  return { turns: turns.data ?? [], actions: actions.data ?? [], files: files.data ?? [] };
}

/** A thumb on one's own answer: 1, -1 or 0 (none), with an optional note. */
export async function rateTurn(turnId, rating, note = null) {
  const { error } = await supabase.rpc('assistant_rate_turn', { p_turn: turnId, p_rating: rating, p_note: note });
  if (error) throw error;
}

/**
 * Confirm was pressed on a prepared change: the database says whether this card may still run
 * (this person's, still open, not older than a day, its kind not turned off) and, once, hands
 * back the change it kept — { id, kind, summary, payload } — which is what gets applied.
 * Throws with the reason otherwise; nothing has changed then.
 */
export async function claimAction(actionId) {
  const { data, error } = await supabase.rpc('assistant_claim_action', { p_action: actionId });
  if (error) throw new Error(error.message);
  return data;
}

/** How a prepared change ended: 'done' | 'cancelled' | 'failed'. The model is told with the next question. */
export async function decideAction(actionId, status, result = null) {
  const { error } = await supabase.rpc('assistant_decide_action', { p_action: actionId, p_status: status, p_result: result });
  if (error) throw error;
}

/** What the assistant was asked and what it cost (admins). */
export async function getAssistantUsage(days = 30) {
  const { data, error } = await supabase.rpc('assistant_usage', { p_days: days });
  if (error) throw error;
  return data;
}

/** The Dashboard's weekly briefing (app_settings 'assistant_briefing'), or null before the first one. */
export const getBriefing = () => getAppSetting('assistant_briefing', null);

async function callFunction(body, { signal } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Your session has expired. Sign in again.');
  return fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/assistant`, {
    method: 'POST',
    signal,
    headers: {
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function refusal(res) {
  let reason = '';
  try {
    reason = (await res.json())?.error ?? '';
  } catch { /* not JSON */ }
  return new Error(reason || `The assistant did not answer (${res.status}).`);
}

/** Builds the briefing now (admins) and returns it. */
export async function refreshBriefing() {
  const res = await callFunction({ mode: 'briefing' });
  if (!res.ok) throw await refusal(res);
  return res.json();
}

/**
 * Asks a question. `onEvent` gets what the function streams, in order:
 *   { type: 'chat', chat_id } · { type: 'step' } · { type: 'text', delta } ·
 *   { type: 'retract' } · { type: 'tool', id, label } · { type: 'tool_done', id, ok } ·
 *   { type: 'action', action } · { type: 'file', file } ·
 *   { type: 'done', turn_id, cost_usd, lookups } ·
 *   { type: 'error', message }
 * `page` = { path, title } of the page it is asked from; `attachments` as
 * lib/attachments.js reads them. Throws when the function refuses the
 * question before answering.
 */
export async function askAssistant({ message, chatId = null, page = null, attachments = [], onEvent, signal }) {
  const res = await callFunction({
    message,
    ...(chatId ? { chat_id: chatId } : {}),
    ...(page ? { page } : {}),
    ...(attachments.length ? { attachments: attachments.map(({ kind, name, media_type, data, text }) => ({ kind, name, media_type, data, text })) } : {}),
  }, { signal });
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) throw await refusal(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (!block.startsWith('data: ')) continue; // keep-alive comments
      let event = null;
      try {
        event = JSON.parse(block.slice(6));
      } catch { /* a broken frame is skipped */ }
      if (event) onEvent?.(event);
    }
  }
}
