import { useEffect, useId, useRef, useState } from 'react';
import Dialog from '@/components/ui/Dialog';
import { TARGET_OPS, parseTarget, targetInput, targetLabel } from '../lib/format';

const field = 'px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

// A measurable's target, set from its cell in the grid (user, 2026-11-12:
// "que permita hacer cambios para los goal"): the comparison and the number.
// An empty number removes it — the row is then tracked without color, or goes
// back to the target it is born with (`born`: "Total vs target" is at least
// 100%).
//
// `metric`  the row ({ name, unit, goal, goal_op })
// `context` where it is, for the subtitle ("Amazon · Canada")
// `onSave`  async ({ goal, goal_op } | null); what it throws is shown here
export default function TargetDialog({ metric, context, born = null, onSave, onClose }) {
  const ids = { form: useId(), op: useId(), value: useId(), hint: useId() };
  const [op, setOp] = useState(metric.goal_op ?? '>=');
  const [value, setValue] = useState(targetInput(metric.unit, metric.goal));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const has = metric.goal != null && Boolean(metric.goal_op);
  // The number is what gets typed: it takes the focus, selected (the dialog
  // itself puts it on its first field, the comparison — this runs after it).
  const number = useRef(null);
  useEffect(() => { number.current?.focus(); number.current?.select(); }, []);

  async function submit(e) {
    e.preventDefault();
    const parsed = parseTarget(metric.unit, value);
    if (parsed.error) { setError(parsed.error); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.goal == null ? null : { goal: parsed.goal, goal_op: op });
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      title={has ? 'Change the target' : 'Set the target'}
      subtitle={[context, metric.name].filter(Boolean).join(' · ')}
      maxWidth="max-w-md"
      footer={(
        <>
          {error && <span role="alert" className="text-body-sm text-error mr-auto">{error}</span>}
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">Cancel</button>
          <button type="submit" form={ids.form} disabled={saving} className="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      {/* the form is inside the dialog and Save names it: a form that IS the dialog takes a role a form may not have (axe) */}
      <form id={ids.form} onSubmit={submit}>
      <fieldset>
        <legend className="block text-label-md text-on-surface mb-1">Each week's number should be</legend>
        <div className="flex items-center gap-2 flex-wrap">
          <label htmlFor={ids.op} className="sr-only">Comparison</label>
          <select id={ids.op} value={op} onChange={(e) => setOp(e.target.value)} className={`${field} w-36`}>
            {TARGET_OPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          {metric.unit === 'money' && <span className="text-body-md text-on-surface-variant" aria-hidden>$</span>}
          <label htmlFor={ids.value} className="sr-only">Target{metric.unit === 'percent' ? ', in percent' : metric.unit === 'money' ? ', in dollars' : ''}</label>
          <input
            ref={number}
            id={ids.value}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={ids.hint}
            className={`${field} w-32 text-right tabular-nums`}
            placeholder="—"
          />
          <span className="text-body-md text-on-surface-variant">{{ percent: '%', hours: 'hours', days: 'days' }[metric.unit] ?? ''}</span>
        </div>
        <p id={ids.hint} className="text-body-sm text-on-surface-variant mt-2">
          A closed week is green with a check when it meets the target and red with a cross when it misses it.{' '}
          {born
            ? `Leave the number empty to go back to ${targetLabel({ ...metric, ...born })}.`
            : 'Leave the number empty to track it without a target: its weeks take no color.'}
        </p>
      </fieldset>
      </form>
    </Dialog>
  );
}
