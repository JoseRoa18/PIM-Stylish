import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Check, CircleSlash, Clock, Loader2, PencilLine } from 'lucide-react';

// A change the assistant prepared, waiting for the person: what would change
// (with the values before), Confirm and Cancel. Nothing happens until Confirm
// — then the change is made by the app's own saves (api/assistantActions.js,
// loaded at that moment), with this person's permissions, and the card says
// how it ended. A card is decided once.
//
// What the assistant flagged when it prepared the change (a price moving 20 %
// or more, a level a running promotion uses, many products at once) is shown
// as warnings, and such a card asks the person to tick that they checked it
// before Confirm works. A card older than a day can no longer be confirmed:
// what it was prepared from may not hold any more.

const SHOWN = 8;
const DAY = 24 * 60 * 60 * 1000;
const money = (v) => (v == null ? 'empty' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const percent = (v) => `${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

const STATE = {
  proposed: { title: 'Change to confirm', icon: PencilLine, tone: 'border-primary/40 bg-primary-container/30' },
  done: { title: 'Change made', icon: Check, tone: 'border-outline-variant bg-success-container/40' },
  cancelled: { title: 'Cancelled — nothing changed', icon: CircleSlash, tone: 'border-outline-variant bg-surface-container-low' },
  failed: { title: 'Not made', icon: AlertCircle, tone: 'border-outline-variant bg-error-container/40' },
  expired: { title: 'Expired — nothing changed', icon: Clock, tone: 'border-outline-variant bg-surface-container-low' },
  interrupted: { title: 'Started — its outcome was not recorded', icon: AlertCircle, tone: 'border-outline-variant bg-error-container/40' },
};

/** Where the card stands: its status, or — still open — expired after a day, or started and never finished. */
function stateOf(action) {
  if (action.status !== 'proposed') return action.status;
  if (action.claimed_at) return 'interrupted';
  const made = Date.parse(action.created_at ?? '');
  return Number.isFinite(made) && Date.now() - made > DAY ? 'expired' : 'proposed';
}

function Item({ item, kind }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <Link to={`/catalog/${encodeURIComponent(item.sku)}`} className="text-primary underline underline-offset-2 font-medium">{item.sku}</Link>
      {item.model && <span className="text-on-surface-variant">{item.model}</span>}
      {kind === 'set_prices' && (
        <span className="text-on-surface">
          {item.label}: {money(item.from)} <span aria-hidden="true">→</span><span className="sr-only">to</span> <strong className="font-semibold">{money(item.to)}</strong>
          {typeof item.change === 'number' && item.change !== 0 && <span className="text-on-surface-variant"> ({percent(item.change)})</span>}
        </span>
      )}
    </li>
  );
}

export default function ActionCard({ action, onDecided }) {
  const [working, setWorking] = useState(null); // 'confirm' | 'cancel'
  const [error, setError] = useState(null);
  const [all, setAll] = useState(false);
  const [checked, setChecked] = useState(false);
  const checkId = useId();
  const key = stateOf(action);
  const state = STATE[key] ?? STATE.proposed;
  const Icon = state.icon;
  const items = action.payload?.items ?? [];
  const shown = all ? items : items.slice(0, SHOWN);
  const warnings = action.payload?.warnings ?? [];
  const needsCheck = action.payload?.needs_check === true;
  const open = key === 'proposed';

  async function decide(which) {
    setWorking(which);
    setError(null);
    try {
      const actions = await import('../api/assistantActions');
      onDecided(which === 'confirm' ? await actions.runAssistantAction(action) : await actions.cancelAssistantAction(action));
    } catch (err) {
      setError(err.message || 'It could not be done.');
    } finally {
      setWorking(null);
    }
  }

  return (
    <section aria-label={`${state.title}: ${action.summary}`} className={`rounded-xl border p-4 space-y-3 ${state.tone}`}>
      <div className="flex items-start gap-2">
        <Icon className="w-4 h-4 mt-0.5 flex-shrink-0 text-on-surface" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-label-md text-on-surface-variant">{state.title}</p>
          <p className="text-body-md text-on-surface font-medium [overflow-wrap:anywhere]">{action.summary}</p>
        </div>
      </div>

      {items.length > 0 && (
        <ul className="text-body-sm space-y-1 pl-6">
          {shown.map((item, i) => <Item key={`${item.sku}.${item.field ?? i}`} item={item} kind={action.kind} />)}
          {items.length > SHOWN && (
            <li>
              <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} className="text-primary underline underline-offset-2">
                {all ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            </li>
          )}
        </ul>
      )}

      {open && warnings.length > 0 && (
        <div className="ml-6 flex items-start gap-2.5 text-body-sm text-on-surface bg-error-container/35 rounded-lg px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-error flex-shrink-0" aria-hidden="true" />
          <ul aria-label="Worth checking before you confirm" className="space-y-1 min-w-0 [overflow-wrap:anywhere]">
            {warnings.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      {open && needsCheck && (
        <label htmlFor={checkId} className="ml-6 flex items-start gap-2 text-body-sm text-on-surface cursor-pointer">
          <input id={checkId} type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={Boolean(working)} className="mt-0.5 w-4 h-4 accent-primary flex-shrink-0" />
          I checked {items.length === 1 ? 'this change' : `these ${items.length} changes`} and want {items.length === 1 ? 'it' : 'them'} made
        </label>
      )}

      {open && (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <button
            type="button"
            onClick={() => decide('confirm')}
            disabled={Boolean(working) || (needsCheck && !checked)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {working === 'confirm' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            Confirm
          </button>
          <button
            type="button"
            onClick={() => decide('cancel')}
            disabled={Boolean(working)}
            className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
      {key === 'expired' && (
        <p className="text-body-sm text-on-surface pl-6">This card is more than a day old, so it can no longer be confirmed. Ask the assistant to prepare the change again.</p>
      )}
      {key === 'interrupted' && (
        <p className="text-body-sm text-on-surface pl-6">Confirm was pressed but the page closed before the result was saved. Check {items.length === 1 ? 'the product' : 'the products'} before asking for this change again.</p>
      )}
      {!open && action.status !== 'proposed' && action.result && (
        <p role="status" className="text-body-sm text-on-surface pl-6 [overflow-wrap:anywhere]">{action.result}</p>
      )}
      {error && <p role="alert" className="text-body-sm text-error pl-6 [overflow-wrap:anywhere]">{error}</p>}
    </section>
  );
}
