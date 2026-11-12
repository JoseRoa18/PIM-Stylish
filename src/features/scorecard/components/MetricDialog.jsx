import { useId, useState } from 'react';
import Dialog from '@/components/ui/Dialog';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { MARKET_LABEL } from '../lib/boards';
import { UNITS, TARGET_OPS, parseTarget, targetInput } from '../lib/format';
import { AUTO_KEYS } from '../lib/autoMetrics';
import { SECTIONS, sectionOf } from '../lib/sections';
import { createMetric, updateMetric, archiveMetric } from '../api/scorecard';

const SOURCES = ['PIM', 'Portal', 'Amazon portal', 'Seller board', 'Asana', 'Odoo', 'Rithum', 'Return file', 'P2S', 'Bazaarvoice', 'SharePoint (Operations)'];
const OTHER = '__other__';

const field = 'w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

// Admins add, edit and remove a board's measurables: name, market, theme,
// owner, target, where the number comes from, and whether the PIM fills it.
export default function MetricDialog({ board, metric = null, defaultMarket = null, people, onClose, onSaved, onRemoved }) {
  const confirm = useConfirm();
  const ids = { name: useId(), market: useId(), section: useId(), owner: useId(), ownerName: useId(), source: useId(), sources: useId(), unit: useId(), op: useId(), goal: useId(), auto: useId() };
  const markets = Object.keys(board.markets);
  const [draft, setDraft] = useState(() => ({
    name: metric?.name ?? '',
    market: metric?.market ?? (markets.includes(defaultMarket) ? defaultMarket : markets[0]),
    section: metric?.section ?? '',
    owner: metric?.owner_id ?? (metric?.owner_name ? OTHER : ''),
    owner_name: metric?.owner_name ?? '',
    source: metric?.source ?? '',
    unit: metric?.unit ?? 'number',
    goal_op: metric?.goal_op ?? '>=',
    goal: targetInput(metric?.unit, metric?.goal),
    auto_key: metric?.auto_key ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  function pickAuto(key) {
    // A PIM-filled measurable takes the unit the PIM gives it.
    set(key ? { auto_key: key, unit: AUTO_KEYS[key].unit, source: 'PIM' } : { auto_key: '' });
  }

  async function submit(e) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) { setError('Give the measurable a name.'); return; }
    const target = draft.unit === 'text' ? { goal: null } : parseTarget(draft.unit, draft.goal);
    if (target.error) { setError(target.error); return; }
    const fields = {
      name,
      market: draft.market,
      section: draft.section || null,
      owner_id: draft.owner && draft.owner !== OTHER ? draft.owner : null,
      owner_name: draft.owner === OTHER ? draft.owner_name.trim() || null : null,
      source: draft.source.trim() || null,
      unit: draft.unit,
      goal: target.goal,
      goal_op: target.goal == null ? null : draft.goal_op,
      auto_key: draft.auto_key || null,
    };
    setSaving(true);
    setError(null);
    try {
      const saved = metric ? await updateMetric(metric, fields) : await createMetric(board.key, fields);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Remove "${metric.name}"?`,
      message: 'It leaves the board. Its weekly numbers are kept in the database.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      await archiveMetric(metric);
      onRemoved(metric);
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Dialog
      as="form"
      onSubmit={submit}
      onClose={onClose}
      title={metric ? 'Edit measurable' : `New measurable · ${board.label}`}
      subtitle="Its owner types the weekly number. A measurable the PIM fills gets its number by itself every week, and nobody can edit it."
      maxWidth="max-w-xl"
      footer={(
        <>
          {error && <span role="alert" className="text-body-sm text-error mr-auto">{error}</span>}
          {metric && !error && (
            <button type="button" onClick={remove} disabled={saving} className="mr-auto px-4 py-2 rounded-full text-label-md text-error hover:bg-error-container/40 transition-colors disabled:opacity-50">Remove</button>
          )}
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 disabled:opacity-50">{saving ? 'Saving…' : metric ? 'Save' : 'Add'}</button>
        </>
      )}
    >
      <div className="space-y-4">
        <div>
          <label htmlFor={ids.name} className="block text-label-md text-on-surface mb-1">Measurable</label>
          <input id={ids.name} value={draft.name} onChange={(e) => set({ name: e.target.value })} className={field} placeholder="e.g. On-time Shipping" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor={ids.market} className="block text-label-md text-on-surface mb-1">Market</label>
            <select id={ids.market} value={draft.market} onChange={(e) => set({ market: e.target.value })} className={field}>
              {markets.map((mk) => <option key={mk} value={mk}>{MARKET_LABEL[mk]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={ids.owner} className="block text-label-md text-on-surface mb-1">Owner</label>
            <select id={ids.owner} value={draft.owner} onChange={(e) => set({ owner: e.target.value })} className={field}>
              <option value="">No owner (admins type it)</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
              <option value={OTHER}>Someone without a PIM user…</option>
            </select>
          </div>
        </div>
        <div>
          <label htmlFor={ids.section} className="block text-label-md text-on-surface mb-1">Theme</label>
          <select id={ids.section} value={draft.section} onChange={(e) => set({ section: e.target.value })} className={field}>
            <option value="">From its name ({SECTIONS.find((s) => s.key === sectionOf({ name: draft.name, unit: draft.unit }))?.label})</option>
            {SECTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        {draft.owner === OTHER && (
          <div>
            <label htmlFor={ids.ownerName} className="block text-label-md text-on-surface mb-1">Owner's name</label>
            <input id={ids.ownerName} value={draft.owner_name} onChange={(e) => set({ owner_name: e.target.value })} className={field} />
            <p className="text-body-sm text-on-surface-variant mt-1">Without a PIM user, an admin types this measurable's numbers.</p>
          </div>
        )}
        <div>
          <label htmlFor={ids.auto} className="block text-label-md text-on-surface mb-1">Filled by the PIM</label>
          <select id={ids.auto} value={draft.auto_key} onChange={(e) => pickAuto(e.target.value)} className={field}>
            <option value="">No — its owner types it</option>
            {/* the server's numbers (Odoo orders, stock…) exist only for boards it fills; a Wix store's own (its orders, reviews) only on Sinks Direct */}
            {Object.entries(AUTO_KEYS).filter(([, a]) => (!a.server || board.serverFill) && (!a.store || board.key === 'sinksdirect' || a.alsoOn?.includes(board.key))).map(([k, a]) => <option key={k} value={k}>{a.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor={ids.source} className="block text-label-md text-on-surface mb-1">Source</label>
            <input id={ids.source} list={ids.sources} value={draft.source} onChange={(e) => set({ source: e.target.value })} className={field} placeholder="Where the number comes from" />
            <datalist id={ids.sources}>{SOURCES.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          <div>
            <label htmlFor={ids.unit} className="block text-label-md text-on-surface mb-1">Unit</label>
            <select id={ids.unit} value={draft.unit} onChange={(e) => set({ unit: e.target.value })} disabled={Boolean(draft.auto_key)} className={`${field} disabled:opacity-60`}>
              {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </div>
        </div>
        {draft.unit !== 'text' && (
          <fieldset>
            <legend className="block text-label-md text-on-surface mb-1">Weekly target</legend>
            <div className="flex items-center gap-2">
              <label htmlFor={ids.op} className="sr-only">Target comparison</label>
              <select id={ids.op} value={draft.goal_op} onChange={(e) => set({ goal_op: e.target.value })} className={`${field} w-40`}>
                {TARGET_OPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <label htmlFor={ids.goal} className="sr-only">Target value</label>
              <input id={ids.goal} inputMode="decimal" value={draft.goal} onChange={(e) => set({ goal: e.target.value })} className={`${field} w-32 text-right tabular-nums`} placeholder="—" />
              <span className="text-body-md text-on-surface-variant">{{ percent: '%', money: '$', hours: 'hours', days: 'days' }[draft.unit] ?? ''}</span>
            </div>
            <p className="text-body-sm text-on-surface-variant mt-1">Leave it empty to track the number without coloring it.</p>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
