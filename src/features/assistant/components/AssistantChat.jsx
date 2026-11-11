import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, Copy, FileSpreadsheet, Image as ImageIcon, Loader2, MessageCircle, Paperclip, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { useAuth } from '@/features/auth/AuthContext';
import { askAssistant, listChats, loadChat, rateTurn } from '../api/assistant';
import { ATTACH_ACCEPT, MAX_ATTACHMENTS, readAttachment } from '../lib/attachments';
import { answerTables, downloadAnswerExcel } from '../lib/answerTables';
import Markdown from './Markdown';
import ActionCard from './ActionCard';
import Dialog from '@/components/ui/Dialog';
import { useDockClearance } from '@/components/ui/useDockClearance';
import { formatTimeAgo } from '@/lib/format';

// The assistant's conversation: the questions and answers, what was looked
// up, the changes it prepared (cards to confirm) and the box to ask from.
// Drawn by the Assistant page (`variant="page"`: the page itself scrolls and
// the box is pinned to its bottom) and by the panel that opens over any page
// (`variant="panel"`: it scrolls inside itself). The conversation lives on
// the server; this sends a question and draws what comes back as it is
// written.

const SUGGESTIONS = [
  'What promotions are running now, and what starts next?',
  '¿Qué productos están sin stock en Canadá y cuándo llegan?',
  'How does Back to Blue work for Wayfair?',
  '¿Qué le falta al S-611W y está bien su precio en las tiendas?',
];

/** A saved question and answer, as it is drawn. */
const fromRow = (row, actions) => ({
  key: `t${row.id}`,
  id: row.id,
  question: row.question,
  attachments: row.attachments ?? [],
  answer: row.answer ?? '',
  tools: (row.tools ?? []).map((t, i) => ({ id: `${row.id}.${i}`, label: t.label ?? t.name, state: t.ok === false ? 'failed' : 'ok' })),
  actions: actions.filter((a) => a.turn_id === row.id),
  status: row.error ? 'error' : 'done',
  error: row.error ?? null,
  cost: row.cost_usd,
  rating: row.rating ?? 0,
});

const cents = (usd) => `${(Number(usd) * 100).toFixed(1)}¢`;

function Lookups({ tools }) {
  if (!tools.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="What was looked up">
      {tools.map((t) => (
        <li key={t.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container text-label-sm text-on-surface-variant max-w-full">
          {t.state === 'running' && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" aria-hidden="true" />}
          {t.state === 'ok' && <Check className="w-3 h-3 flex-shrink-0" aria-hidden="true" />}
          {t.state === 'failed' && <X className="w-3 h-3 flex-shrink-0 text-error" aria-hidden="true" />}
          <span className="truncate">{t.label}</span>
          {t.state === 'failed' && <span className="sr-only">(failed)</span>}
        </li>
      ))}
    </ul>
  );
}

function AttachmentChip({ file, onRemove = null }) {
  const Icon = file.kind === 'image' ? ImageIcon : FileSpreadsheet;
  return (
    <span className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-full bg-surface-container text-label-sm text-on-surface-variant max-w-full">
      <Icon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{file.name}{file.kind === 'table' && file.rows ? ` · ${file.rows}${file.of > file.rows ? ` of ${file.of}` : ''} rows` : ''}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`} className="p-[5px] -m-[3px] rounded-full hover:bg-surface-container-high hover:text-on-surface transition-colors">
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

const TOOL_BUTTON = 'inline-flex items-center gap-1.5 py-1 -my-1 rounded hover:text-on-surface transition-colors disabled:opacity-50';

function Turn({ turn, showCost, onRate, onActionDecided }) {
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [askNote, setAskNote] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  const streaming = turn.status === 'streaming';
  const waiting = streaming && !turn.tools.some((t) => t.state === 'running') && (!turn.answer || turn.betweenSteps);
  const hasTable = useMemo(() => turn.status === 'done' && answerTables(turn.answer).length > 0, [turn.status, turn.answer]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(turn.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard not allowed: nothing to say */ }
  }

  async function excel() {
    setExporting(true);
    try {
      await downloadAnswerExcel(turn.answer);
    } catch { /* nothing to download */ } finally {
      setExporting(false);
    }
  }

  function rate(value) {
    const next = turn.rating === value ? 0 : value;
    onRate(turn, next, null);
    setAskNote(next === -1);
    if (next !== -1) setNote('');
  }

  return (
    <article className="space-y-3">
      <div className="flex flex-col items-end gap-1.5">
        <h2 className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary-container text-on-secondary-container px-4 py-2.5 text-body-md font-normal whitespace-pre-wrap [overflow-wrap:anywhere]">
          {turn.question}
        </h2>
        {turn.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            {turn.attachments.map((file, i) => <AttachmentChip key={i} file={file} />)}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <Lookups tools={turn.tools} />
        {turn.answer && <Markdown text={turn.answer} />}
        {turn.actions.map((action) => <ActionCard key={action.id} action={action} onDecided={(outcome) => onActionDecided(turn, action, outcome)} />)}
        {waiting && (
          <p className="flex items-center gap-2 text-body-sm text-on-surface-variant">
            <ThinkingOrb state="solving" size={20} className="w-5 h-5" aria-hidden="true" />
            Thinking…
          </p>
        )}
        {turn.status === 'error' && (
          <p role="alert" className="text-body-sm text-error">{turn.error || 'The assistant could not answer.'}</p>
        )}
        {turn.status === 'done' && turn.answer && (
          <div className="flex items-center gap-4 flex-wrap text-label-sm text-on-surface-variant">
            <button type="button" onClick={copy} className={TOOL_BUTTON}>
              {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
              <span role="status">{copied ? 'Copied' : 'Copy'}</span>
            </button>
            {hasTable && (
              <button type="button" onClick={excel} disabled={exporting} className={TOOL_BUTTON}>
                {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" />}
                Excel
              </button>
            )}
            {turn.id != null && (
              <span className="inline-flex items-center gap-1">
                <button type="button" onClick={() => rate(1)} aria-pressed={turn.rating === 1} aria-label="Good answer" className={`p-[5px] rounded-full transition-colors hover:bg-surface-container ${turn.rating === 1 ? 'text-success' : 'hover:text-on-surface'}`}>
                  <ThumbsUp className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button type="button" onClick={() => rate(-1)} aria-pressed={turn.rating === -1} aria-label="Wrong or unhelpful answer" className={`p-[5px] rounded-full transition-colors hover:bg-surface-container ${turn.rating === -1 ? 'text-error' : 'hover:text-on-surface'}`}>
                  <ThumbsDown className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </span>
            )}
            {showCost && turn.cost != null && <span title="What this answer cost">{cents(turn.cost)}</span>}
          </div>
        )}
        {askNote && turn.rating === -1 && (
          <form
            className="relative flex items-center gap-2 max-w-md"
            onSubmit={(e) => {
              e.preventDefault();
              onRate(turn, -1, note.trim() || null);
              setAskNote(false);
            }}
          >
            <label htmlFor={noteId} className="sr-only">What was wrong with this answer?</label>
            <input
              id={noteId}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="What was wrong? (optional)"
              className="flex-1 min-w-0 px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button type="submit" className="px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">Send</button>
          </form>
        )}
      </div>
    </article>
  );
}

function ChatsDialog({ onClose, onPick, current }) {
  const [chats, setChats] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    listChats().then((rows) => { if (active) setChats(rows); }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  return (
    <Dialog onClose={onClose} title="Conversations" subtitle="Your earlier conversations with the assistant." maxWidth="max-w-lg">
      {error && <p role="alert" className="text-body-sm text-error">{error}</p>}
      {!error && chats === null && (
        <p role="status" className="flex items-center gap-2 text-body-sm text-on-surface-variant py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}
      {chats?.length === 0 && <p className="text-body-sm text-on-surface-variant py-6 text-center">No conversations yet.</p>}
      {chats?.length > 0 && (
        <ul className="divide-y divide-outline-variant -my-2">
          {chats.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                aria-current={c.id === current ? 'true' : undefined}
                className="w-full text-left py-3 px-2 -mx-2 rounded-lg hover:bg-surface-container-low transition-colors flex items-baseline justify-between gap-4"
              >
                <span className={`text-body-md truncate text-on-surface ${c.id === current ? 'font-semibold' : ''}`}>{c.title}</span>
                <span className="text-label-sm text-on-surface-variant flex-shrink-0">{formatTimeAgo(c.updated_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/**
 * Props:
 *   variant      'page' (the page scrolls, the box is pinned to its bottom) | 'panel'
 *   chatId       the conversation shown (null = a new one); onChatId(id | null) when it changes
 *   pageContext  () => ({ path, title }) — the page a question is asked from (the panel)
 *   focusSignal  a number: when it changes, the question box takes the focus
 *   header       ({ newChat, openChats, busy, canReset }) => the top of the chat (title, buttons)
 */
export default function AssistantChat({ variant = 'page', chatId = null, onChatId, pageContext = null, focusSignal = 0, header = null }) {
  const { isAdmin } = useAuth();
  const panel = variant === 'panel';

  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState([]);
  const [fileError, setFileError] = useState(null);
  const [reading, setReading] = useState(false);
  const [showChats, setShowChats] = useState(false);
  const [announce, setAnnounce] = useState('');

  const chatIdRef = useRef(null);
  const busyRef = useRef(false);
  const inputRef = useRef(null);
  const composerRef = useRef(null);
  const scrollRef = useRef(null);
  const stickRef = useRef(true); // is the reader at the bottom of the conversation?
  const inputId = useId();
  const fileId = useId();
  useDockClearance(composerRef);

  const scroller = useCallback(() => (panel ? scrollRef.current : document.getElementById('main-content')), [panel]);
  const toBottom = useCallback(() => {
    const el = scroller();
    if (el) el.scrollTop = el.scrollHeight;
  }, [scroller]);

  // Follow the answer while it is written — unless the reader scrolled up.
  useEffect(() => {
    const el = scroller();
    if (!el) return undefined;
    const onScroll = () => { stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scroller]);
  useEffect(() => {
    if (stickRef.current) toBottom();
  }, [turns, toBottom]);

  useEffect(() => {
    if (focusSignal) inputRef.current?.focus();
  }, [focusSignal]);

  // The conversation asked for from outside (the address, a pick from the list).
  useEffect(() => {
    if (busyRef.current) return undefined;
    if (!chatId) {
      if (chatIdRef.current) {
        chatIdRef.current = null;
        setTurns([]);
      }
      return undefined;
    }
    if (chatId === chatIdRef.current) return undefined;
    let active = true;
    setLoadingChat(true);
    setLoadError(null);
    loadChat(chatId)
      .then(({ turns: rows, actions }) => {
        if (!active) return;
        chatIdRef.current = chatId;
        setTurns(rows.map((row) => fromRow(row, actions)));
        stickRef.current = true;
      })
      .catch((err) => { if (active) setLoadError(err.message); })
      .finally(() => { if (active) setLoadingChat(false); });
    return () => { active = false; };
  }, [chatId]);

  function newChat() {
    if (busyRef.current) return;
    chatIdRef.current = null;
    setTurns([]);
    setLoadError(null);
    setFiles([]);
    setFileError(null);
    onChatId?.(null);
    inputRef.current?.focus();
  }

  async function attach(list) {
    const chosen = [...(list ?? [])];
    if (!chosen.length) return;
    setFileError(null);
    setReading(true);
    const added = [];
    const problems = [];
    for (const file of chosen) {
      if (files.length + added.length >= MAX_ATTACHMENTS) {
        problems.push(`At most ${MAX_ATTACHMENTS} files per question.`);
        break;
      }
      try {
        added.push(await readAttachment(file));
      } catch (err) {
        problems.push(err.message);
      }
    }
    setFiles((current) => [...current, ...added].slice(0, MAX_ATTACHMENTS));
    setFileError(problems.length ? problems.join(' ') : null);
    setReading(false);
  }

  async function ask(text) {
    const question = text.trim();
    if (!question || busyRef.current) return;
    const key = `n${Date.now()}`;
    const attachments = files;
    busyRef.current = true;
    setBusy(true);
    setDraft('');
    setFiles([]);
    setFileError(null);
    setAnnounce('The assistant is answering…');
    stickRef.current = true;
    setTurns((list) => [...list, { key, id: null, question, attachments: attachments.map(({ kind, name }) => ({ kind, name })), answer: '', tools: [], actions: [], status: 'streaming', error: null, cost: null, rating: 0, betweenSteps: false }]);
    if (inputRef.current) {
      inputRef.current.style.height = '';
      inputRef.current.style.overflowY = '';
    }

    const patch = (fn) => setTurns((list) => list.map((t) => (t.key === key ? fn(t) : t)));
    // The answer is kept here as it grows and handed to the page whole. Text
    // arrives a few characters at a time: it is drawn at most 25 times a second.
    let answer = '';
    let stepStart = 0;
    let pending = '';
    let timer = null;
    const show = (extra = {}) => {
      const whole = answer;
      patch((t) => ({ ...t, answer: whole, ...extra }));
    };
    const flush = () => {
      timer = null;
      if (!pending) return;
      answer += pending;
      pending = '';
      show({ betweenSteps: false });
    };
    const onEvent = (event) => {
      if (event.type === 'text') {
        pending += event.delta;
        timer ??= setTimeout(flush, 40);
        return;
      }
      clearTimeout(timer);
      flush();
      if (event.type === 'chat') {
        chatIdRef.current = event.chat_id;
        onChatId?.(event.chat_id);
      } else if (event.type === 'step') {
        // A new step of the same answer starts on its own paragraph.
        if (answer && !answer.endsWith('\n\n')) answer += '\n\n';
        stepStart = answer.length;
        show({ betweenSteps: true });
      } else if (event.type === 'retract') {
        answer = answer.slice(0, stepStart);
        show();
      } else if (event.type === 'tool') {
        patch((t) => ({ ...t, tools: [...t.tools, { id: event.id, label: event.label, state: 'running' }] }));
      } else if (event.type === 'tool_done') {
        patch((t) => ({ ...t, tools: t.tools.map((x) => (x.id === event.id ? { ...x, state: event.ok ? 'ok' : 'failed' } : x)) }));
      } else if (event.type === 'action') {
        patch((t) => ({ ...t, actions: [...t.actions, event.action] }));
      } else if (event.type === 'done') {
        answer = answer.trimEnd();
        show({ status: 'done', id: event.turn_id ?? null, cost: event.cost_usd, betweenSteps: false });
        setAnnounce('The answer is ready.');
      } else if (event.type === 'error') {
        answer = answer.trimEnd();
        show({ status: 'error', error: event.message, betweenSteps: false });
        setAnnounce('');
      }
    };

    try {
      await askAssistant({ message: question, chatId: chatIdRef.current, page: pageContext?.() ?? null, attachments, onEvent });
      clearTimeout(timer);
      flush();
      // The stream ended without saying how: the connection was cut.
      patch((t) => (t.status === 'streaming' ? { ...t, status: 'error', error: 'The connection was cut before the answer finished. Ask again.' } : t));
    } catch (err) {
      clearTimeout(timer);
      flush();
      patch((t) => ({ ...t, status: 'error', error: err.message || 'The assistant could not answer.' }));
      setAnnounce('');
    } finally {
      busyRef.current = false;
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function rate(turn, rating, noteText) {
    const before = turn.rating;
    setTurns((list) => list.map((t) => (t.key === turn.key ? { ...t, rating } : t)));
    rateTurn(turn.id, rating, noteText).catch(() => {
      setTurns((list) => list.map((t) => (t.key === turn.key ? { ...t, rating: before } : t)));
    });
  }

  function actionDecided(turn, action, outcome) {
    setTurns((list) => list.map((t) => (t.key === turn.key ? { ...t, actions: t.actions.map((a) => (a.id === action.id ? { ...a, ...outcome } : a)) } : t)));
  }

  function onKeyDown(e) {
    // Enter sends; Shift + Enter is a new line (and Enter while composing accents is left alone).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(draft);
    }
  }

  function onInput(e) {
    setDraft(e.target.value);
    // The box grows with the text up to 12 rem, and only then scrolls.
    e.target.style.height = 'auto';
    e.target.style.overflowY = e.target.scrollHeight > 192 ? 'auto' : 'hidden';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 192)}px`;
  }

  function onPaste(e) {
    // A screenshot pasted into the box is attached.
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (images.length) {
      e.preventDefault();
      attach(images);
    }
  }

  const empty = turns.length === 0 && !loadingChat && !loadError;

  const conversation = (
    <>
      {loadingChat && (
        <p role="status" className="flex items-center gap-2 text-body-sm text-on-surface-variant py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading the conversation…
        </p>
      )}
      {loadError && <p role="alert" className="text-body-sm text-error py-6">The conversation could not be loaded: {loadError}</p>}

      {empty && (
        <div className={panel ? 'pb-2' : 'rounded-2xl border border-outline-variant bg-surface p-6 mb-4'}>
          <div className="flex items-center gap-2 text-on-surface">
            <MessageCircle className="w-5 h-5 text-primary flex-shrink-0" aria-hidden="true" />
            <p className="text-title-md">Try one of these, or write your own — in English or Spanish.</p>
          </div>
          <ul className={`grid gap-2 mt-4 ${panel ? '' : 'sm:grid-cols-2'}`}>
            {SUGGESTIONS.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => ask(s)}
                  className="w-full h-full text-left px-4 py-3 rounded-xl border border-outline-variant text-body-sm text-on-surface hover:bg-surface-container-low transition-colors"
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {turns.length > 0 && (
        <div className={`space-y-8 ${panel ? '' : 'mb-6'}`}>
          {turns.map((turn) => <Turn key={turn.key} turn={turn} showCost={isAdmin} onRate={rate} onActionDecided={actionDecided} />)}
        </div>
      )}

      {/* One quiet announcement per answer: its text is not read out as it is written. */}
      <p role="status" className="sr-only">{announce}</p>
    </>
  );

  const composer = (
    <form
      ref={composerRef}
      onSubmit={(e) => { e.preventDefault(); ask(draft); }}
      className={panel ? 'flex-shrink-0 px-4 pt-2 pb-3 border-t border-outline-variant bg-surface' : 'sticky bottom-0 z-10 pt-2 pb-3 bg-background'}
    >
      {(files.length > 0 || reading) && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {files.map((file, i) => <AttachmentChip key={`${file.name}.${i}`} file={file} onRemove={() => setFiles((current) => current.filter((_, n) => n !== i))} />)}
          {reading && (
            <span role="status" className="inline-flex items-center gap-1.5 text-label-sm text-on-surface-variant">
              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> Reading the file…
            </span>
          )}
        </div>
      )}
      {fileError && <p role="alert" className="text-label-sm text-error mb-2">{fileError}</p>}
      <div className={`relative flex items-end gap-1 rounded-2xl border border-outline-variant pl-2 pr-2 py-2 focus-within:ring-2 focus-within:ring-primary/30 ${panel ? 'bg-surface-container-low' : 'bg-surface'}`}>
        <label
          htmlFor={fileId}
          className="relative p-2.5 rounded-full text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors cursor-pointer flex-shrink-0 focus-within:ring-2 focus-within:ring-primary/40"
        >
          <Paperclip className="w-4 h-4" aria-hidden="true" />
          <span className="sr-only">Attach an image or a table (.xlsx, .csv)</span>
          <input
            id={fileId}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            disabled={busy || files.length >= MAX_ATTACHMENTS}
            onChange={(e) => {
              attach(e.target.files);
              e.target.value = '';
            }}
            className="sr-only"
          />
        </label>
        <label htmlFor={inputId} className="sr-only">Your question</label>
        <textarea
          id={inputId}
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          maxLength={4000}
          placeholder="Ask a question…"
          className="flex-1 min-w-0 resize-none overflow-hidden bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant py-1.5 max-h-48 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || reading || !draft.trim()}
          aria-label="Send"
          className="p-2.5 rounded-full bg-primary text-on-primary hover:opacity-90 transition-opacity disabled:opacity-40 flex-shrink-0"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ArrowUp className="w-4 h-4" aria-hidden="true" />}
        </button>
      </div>
      <p className="text-label-sm text-on-surface-variant mt-1.5 px-1">Enter to send · Shift + Enter for a new line</p>
    </form>
  );

  const top = header?.({ newChat, openChats: () => setShowChats(true), busy, canReset: Boolean(chatId) || turns.length > 0 });
  const dialog = showChats && (
    <ChatsDialog
      current={chatId}
      onClose={() => setShowChats(false)}
      onPick={(id) => {
        setShowChats(false);
        if (!busyRef.current) onChatId?.(id);
      }}
    />
  );

  if (panel) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {top}
        {/* It scrolls inside itself, apart from the page's smooth scrolling. */}
        <div ref={scrollRef} data-lenis-prevent role="region" aria-label="Conversation" tabIndex={0} className="relative flex-1 min-h-0 overflow-y-auto px-4 py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30">
          {conversation}
        </div>
        {composer}
        {dialog}
      </div>
    );
  }
  return (
    <>
      {top}
      {conversation}
      {composer}
      {dialog}
    </>
  );
}
