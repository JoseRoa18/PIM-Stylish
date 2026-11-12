import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, CircleSlash, Loader2, PencilLine } from 'lucide-react';

// A change the assistant prepared, waiting for the person: what would change
// (with the values before), Confirm and Cancel. Nothing happens until Confirm
// — then the change is made by the app's own saves (api/assistantActions.js,
// loaded at that moment), with this person's permissions, and the card says
// how it ended. A card is decided once.

const SHOWN = 8;
const money = (v) => (v == null ? 'empty' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));

const STATE = {
  proposed: { title: 'Change to confirm', icon: PencilLine, tone: 'border-primary/40 bg-primary-container/30' },
  done: { title: 'Change made', icon: Check, tone: 'border-outline-variant bg-success-container/40' },
  cancelled: { title: 'Cancelled — nothing changed', icon: CircleSlash, tone: 'border-outline-variant bg-surface-container-low' },
  failed: { title: 'Not made', icon: AlertCircle, tone: 'border-outline-variant bg-error-container/40' },
};

function Item({ item, kind }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <Link to={`/catalog/${encodeURIComponent(item.sku)}`} className="text-primary underline underline-offset-2 font-medium">{item.sku}</Link>
      {item.model && <span className="text-on-surface-variant">{item.model}</span>}
      {kind === 'set_prices' && (
        <span className="text-on-surface">
          {item.label}: {money(item.from)} <span aria-hidden="true">→</span><span className="sr-only">to</span> <strong className="font-semibold">{money(item.to)}</strong>
        </span>
      )}
    </li>
  );
}

export default function ActionCard({ action, onDecided }) {
  const [working, setWorking] = useState(null); // 'confirm' | 'cancel'
  const [error, setError] = useState(null);
  const [all, setAll] = useState(false);
  const state = STATE[action.status] ?? STATE.proposed;
  const Icon = state.icon;
  const items = action.payload?.items ?? [];
  const shown = all ? items : items.slice(0, SHOWN);

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

      {action.status === 'proposed' && (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <button
            type="button"
            onClick={() => decide('confirm')}
            disabled={Boolean(working)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
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
      {action.status !== 'proposed' && action.result && (
        <p role="status" className="text-body-sm text-on-surface pl-6 [overflow-wrap:anywhere]">{action.result}</p>
      )}
      {error && <p role="alert" className="text-body-sm text-error pl-6">{error}</p>}
    </section>
  );
}
