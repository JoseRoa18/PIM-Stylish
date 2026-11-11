import { useEffect, useId, useState } from 'react';
import { MessageCircle, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getAssistantSetting, getAssistantUsage, saveAssistantSetting } from '../api/assistant';
import { formatDate, formatTimeAgo } from '@/lib/format';

// Settings → Assistant (admins): who may use it, how much it may spend in 24
// hours, how hard it thinks, and what it has been asked and has cost. The
// setting is app_settings 'assistant'; the function reads it on every
// question, so a change here applies to the next one.

const EFFORTS = [
  ['low', 'Faster — shorter thinking'],
  ['medium', 'Balanced'],
  ['high', 'Deeper — slower, costs more'],
];
const DEFAULT_LIMIT = 5;
const usd = (v) => `$${Number(v ?? 0).toFixed(2)}`;
const lower = (v) => String(v ?? '').trim().toLowerCase();

function Switch({ checked, disabled, onChange, label, describedBy }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full flex-shrink-0 transition-colors disabled:opacity-40 ${checked ? 'bg-primary' : 'bg-surface-container-highest border border-outline-variant'}`}
    >
      <span className={`absolute left-0 top-0.5 w-5 h-5 rounded-full shadow-sm transition-transform ${checked ? 'bg-on-primary translate-x-[22px]' : 'bg-on-surface-variant/70 translate-x-0.5'}`} />
    </button>
  );
}

const FIELD = 'px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30';

export default function AssistantSettings() {
  const descriptionId = useId();
  const addId = useId();
  const limitId = useId();
  const effortId = useId();
  const [setting, setSetting] = useState(null); // null while loading
  const [usage, setUsage] = useState(null);
  const [people, setPeople] = useState([]);
  const [adding, setAdding] = useState('');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getAssistantSetting({ fresh: true })
      .then((value) => {
        setSetting(value ?? {});
        setLimit(String(value?.daily_limit_usd ?? DEFAULT_LIMIT));
      })
      .catch((err) => { setSetting({}); setError(err.message); });
    getAssistantUsage(30).then(setUsage).catch(() => {});
    supabase.from('profiles').select('email, full_name, role').order('full_name').then(({ data }) => setPeople(data ?? []));
  }, []);

  async function save(next) {
    const before = setting;
    setSetting(next);
    setError(null);
    setSaved(false);
    try {
      await saveAssistantSetting(next);
      setSaved(true);
    } catch (err) {
      setSetting(before);
      setError(err.message);
    }
  }

  const loading = setting === null;
  const emails = (setting?.emails ?? []).map(lower);
  const personOf = (email) => people.find((p) => lower(p.email) === email);
  const candidates = people.filter((p) => p.email && !emails.includes(lower(p.email)));
  const limitNumber = Number(limit);
  const limitChanged = !loading && limitNumber > 0 && limitNumber !== Number(setting.daily_limit_usd ?? DEFAULT_LIMIT);
  const teamGuide = usage?.knowledge?.guide_user ?? null;

  return (
    <section className="rounded-2xl bg-surface p-6 border border-outline-variant">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
            <MessageCircle className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-title-md text-on-surface font-semibold">Assistant</h2>
            <p id={descriptionId} className="text-body-sm text-on-surface-variant mt-0.5 max-w-md">
              The chat that explains the PIM and looks its data up. It reads with the permissions of the person asking; a change it prepares is made only when that person confirms it.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-label-lg text-on-surface">{loading ? '…' : setting.enabled ? 'On' : 'Off'}</span>
          <Switch checked={setting?.enabled === true} disabled={loading} onChange={(on) => save({ ...setting, enabled: on })} label="Assistant" describedBy={descriptionId} />
        </div>
      </div>

      {!loading && (
        <div className="mt-5 space-y-5">
          <div>
            <h3 className="text-label-lg font-medium text-on-surface">Who can use it</h3>
            <ul className="flex flex-wrap gap-1.5 mt-2">
              {emails.map((email) => {
                const person = personOf(email);
                return (
                  <li key={email} className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full bg-surface-container text-body-sm text-on-surface">
                    <span>{person?.full_name || email}</span>
                    {person?.role && <span className="text-label-sm text-on-surface-variant">{person.role}</span>}
                    <button
                      type="button"
                      onClick={() => save({ ...setting, emails: emails.filter((e) => e !== email) })}
                      aria-label={`Remove ${person?.full_name || email}`}
                      className="p-[5px] rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
                    >
                      <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
              {emails.length === 0 && <li className="text-body-sm text-on-surface-variant">Nobody yet.</li>}
            </ul>
            <div className="relative flex flex-wrap items-center gap-2 mt-3">
              <label htmlFor={addId} className="sr-only">Person to add</label>
              <select id={addId} value={adding} onChange={(e) => setAdding(e.target.value)} className={FIELD}>
                <option value="">Add a person…</option>
                {candidates.map((p) => <option key={p.email} value={lower(p.email)}>{p.full_name || p.email} — {p.role}</option>)}
              </select>
              <button
                type="button"
                disabled={!adding}
                onClick={() => {
                  save({ ...setting, emails: [...emails, adding] });
                  setAdding('');
                }}
                className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40"
              >
                Add
              </button>
            </div>
            <p className="text-body-sm text-on-surface-variant mt-2 max-w-2xl">
              Admins are answered from the developers’ documentation. Everyone else is answered from the team’s guide, a version of it without the technical detail
              {teamGuide ? ` (last written ${formatDate(teamGuide)})` : ' — it has not been written yet, so only admins can be answered for now'}.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor={limitId} className="block text-label-lg font-medium text-on-surface">Limit per 24 hours (USD)</label>
              <div className="flex items-center gap-2 mt-2">
                <input id={limitId} type="number" min="1" step="1" value={limit} onChange={(e) => setLimit(e.target.value)} className={`${FIELD} w-28`} />
                <button
                  type="button"
                  disabled={!limitChanged}
                  onClick={() => save({ ...setting, daily_limit_usd: limitNumber })}
                  className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </div>
            <div>
              <label htmlFor={effortId} className="block text-label-lg font-medium text-on-surface">How much it thinks</label>
              <select id={effortId} value={setting.effort ?? 'medium'} onChange={(e) => save({ ...setting, effort: e.target.value })} className={`${FIELD} mt-2`}>
                {EFFORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>

          {usage && (
            <div className="rounded-xl bg-surface-container-low/60 p-4 space-y-3">
              <p className="text-body-sm text-on-surface">
                <span className="font-medium">Last 24 hours:</span> {usd(usage.last_24h_usd)} of {usd(setting.daily_limit_usd ?? DEFAULT_LIMIT)}
                <span className="text-on-surface-variant"> · </span>
                <span className="font-medium">Last {usage.days} days:</span> {usd(usage.period_usd)} in {usage.questions} {usage.questions === 1 ? 'question' : 'questions'}
                <span className="text-on-surface-variant"> · </span>
                <ThumbsUp className="inline w-3.5 h-3.5 -mt-0.5" aria-hidden="true" /> {usage.thumbs_up}<span className="sr-only"> good answers</span>
                {' '}
                <ThumbsDown className="inline w-3.5 h-3.5 -mt-0.5 ml-1" aria-hidden="true" /> {usage.thumbs_down}<span className="sr-only"> wrong answers</span>
              </p>
              {usage.by_person.length > 0 && (
                <ul className="text-body-sm text-on-surface-variant space-y-0.5">
                  {usage.by_person.map((p) => (
                    <li key={p.email}>
                      <span className="text-on-surface">{personOf(lower(p.email))?.full_name || p.email}</span>: {p.questions} {p.questions === 1 ? 'question' : 'questions'}, {usd(p.usd)} — last {formatTimeAgo(p.last)}
                    </li>
                  ))}
                </ul>
              )}
              {usage.recent.length > 0 && (
                <details>
                  <summary className="text-label-lg text-primary cursor-pointer">Latest questions</summary>
                  <ul className="mt-2 divide-y divide-outline-variant">
                    {usage.recent.map((q) => (
                      <li key={q.id} className="py-2 text-body-sm">
                        <p className="text-on-surface [overflow-wrap:anywhere]">{q.question}</p>
                        <p className="text-label-sm text-on-surface-variant mt-0.5">
                          {personOf(lower(q.email))?.full_name || q.email} · {formatTimeAgo(q.at)} · {usd(q.usd)}{q.seconds != null ? ` · ${q.seconds} s` : ''}
                          {q.rating === 1 && ' · good answer'}
                          {q.rating === -1 && ` · wrong answer${q.note ? `: ${q.note}` : ''}`}
                          {q.error && ` · failed: ${q.error}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {usage.knowledge?.guide && (
                <p className="text-label-sm text-on-surface-variant">Its knowledge of the app was last updated {formatTimeAgo(usage.knowledge.guide)}.</p>
              )}
            </div>
          )}
        </div>
      )}

      {saved && !error && <p role="status" className="sr-only">Saved.</p>}
      {error && <p role="alert" className="text-body-sm text-error mt-3">{error}</p>}
    </section>
  );
}
