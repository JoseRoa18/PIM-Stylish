import { useState } from 'react';
import Dialog from '@/components/ui/Dialog';
import { CATEGORY_LABEL } from '@/features/products/lib/completeness';
import { saveTargets } from '../api/kpi';

// Admin-only: the share of products at 100% each category should reach, and
// by when. Stored in app settings; the progress table projects against it.
export default function TargetsDialog({ targets, categories, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => ({
    global: { pct: targets?.global?.pct ?? '', date: targets?.global?.date ?? '' },
    categories: Object.fromEntries(categories.map((c) => [c, { pct: targets?.categories?.[c]?.pct ?? '', date: targets?.categories?.[c]?.date ?? '' }])),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const setCat = (cat, patch) => setDraft((d) => ({ ...d, categories: { ...d.categories, [cat]: { ...d.categories[cat], ...patch } } }));
  const clean = (t) => (t.pct === '' || t.pct == null ? null : { pct: Math.max(0, Math.min(100, Number(t.pct))), date: t.date || null });

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const value = {
        global: clean(draft.global),
        categories: Object.fromEntries(Object.entries(draft.categories).map(([c, t]) => [c, clean(t)]).filter(([, v]) => v)),
      };
      await saveTargets(value);
      onSaved(value);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const applyAll = () => setDraft((d) => ({ ...d, categories: Object.fromEntries(Object.keys(d.categories).map((c) => [c, { ...d.global }])) }));

  return (
    <Dialog
      as="form"
      onSubmit={submit}
      onClose={onClose}
      title="Completeness targets"
      subtitle="Share of products at 100% to reach, and by when. Leave a category blank to track it without a target."
      footer={(
        <>
          {error && <span className="text-body-sm text-error mr-auto">{error}</span>}
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 disabled:opacity-50">{saving ? 'Saving…' : 'Save targets'}</button>
        </>
      )}
    >
      <div className="space-y-4">
        <Row label="Whole catalog" value={draft.global} onChange={(patch) => setDraft((d) => ({ ...d, global: { ...d.global, ...patch } }))}>
          <button type="button" onClick={applyAll} className="text-label-md text-primary font-semibold hover:underline whitespace-nowrap">Apply to all</button>
        </Row>
        <div className="border-t border-outline-variant" />
        {categories.map((c) => (
          <Row key={c} label={CATEGORY_LABEL[c] ?? c} value={draft.categories[c]} onChange={(patch) => setCat(c, patch)} />
        ))}
      </div>
    </Dialog>
  );
}

function Row({ label, value, onChange, children }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3">
      <span className="text-body-md text-on-surface">{label}</span>
      <label className="flex items-center gap-1 text-body-sm text-on-surface-variant">
        <input type="number" min="0" max="100" value={value.pct} onChange={(e) => onChange({ pct: e.target.value })} placeholder="—" className="w-20 px-2 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30" aria-label={`${label} target percent`} />
        %
      </label>
      <label className="flex items-center gap-1 text-body-sm text-on-surface-variant">
        by
        <input type="date" value={value.date} onChange={(e) => onChange({ date: e.target.value })} className="px-2 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30" aria-label={`${label} target date`} />
      </label>
      <span className="w-20 text-right">{children}</span>
    </div>
  );
}
