import { useState } from 'react';
import { updatePromotionStylishDiscount } from '@/features/pricing/api/promotions';
import { buildStylishDiscount, draftFromDiscount, stylishMarkets } from '@/features/pricing/lib/stylishDraft';
import { CUSTOMER_OFF, storePriceFor } from '@/features/pricing/lib/stylishDiscount';

const money = (n) => `$${Number(n).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const input = 'mt-1 w-full px-3 py-2 rounded-lg bg-surface-container-low border border-outline-variant text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40';
const MARKET = { ca: { label: 'Stylish Canada', currency: 'CAD' }, us: { label: 'Stylish USA', currency: 'USD' } };

// The worked example under the fields, with the numbers being typed.
function example(draft) {
  const customer = 100 * (1 - CUSTOMER_OFF / 100);
  const typed = Number(draft.percent);
  const percent = typed > 0 && typed < 100 ? typed : 10;
  const pays = customer * (1 - percent / 100);
  return `Example: MSRP ${money(100)}, the customer pays ${money(customer)} with the website's ${CUSTOMER_OFF}%. ${percent}% off makes it ${money(pays)}, so the store shows ${money(storePriceFor(pays))}.`;
}

/**
 * How a special event discounts the Stylish stores: a percentage, or what the
 * customer pays per product. Used by the new-event form and by the card.
 */
export default function StylishDiscountFields({ draft, onChange, markets }) {
  const set = (patch) => onChange({ ...draft, ...patch });
  return (
    <fieldset className="rounded-xl border border-outline-variant p-4 space-y-3">
      <legend className="px-1 text-label-lg text-on-surface-variant">Stylish stores: discount</legend>
      <div className="inline-flex rounded-lg bg-surface-container p-1">
        {[['percent', 'Percentage'], ['price', 'Price']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={draft.mode === key}
            onClick={() => set({ mode: key })}
            className={`px-3 py-1.5 rounded-md text-label-lg font-medium transition-colors ${draft.mode === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {draft.mode === 'percent' ? (
        <label className="block max-w-40">
          <span className="text-label-md text-on-surface-variant">Discount (%)</span>
          <input type="number" min="0" max="100" step="any" value={draft.percent} onChange={(e) => set({ percent: e.target.value })} placeholder="10" className={input} />
        </label>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {markets.map((m) => (
            <label key={m} className="block">
              <span className="text-label-md text-on-surface-variant">{MARKET[m].label}: SKU and what the customer pays ({MARKET[m].currency}), one per line</span>
              <textarea value={draft[m]} onChange={(e) => set({ [m]: e.target.value })} rows={5} placeholder="S-611W 386.91" className={`${input} font-mono text-body-sm`} />
            </label>
          ))}
        </div>
      )}
      <p className="text-body-sm text-on-surface-variant">
        {draft.mode === 'percent'
          ? example(draft)
          : `The website gives the customer ${CUSTOMER_OFF}% off, so the store shows that amount ÷ 0.3. A product listed here joins the event.`}
        {' '}It goes on by itself the first day and comes off when the event ends; the MSRP stays as it is.
      </p>
    </fieldset>
  );
}

/** On the card of a special event that goes to a Stylish store. */
export function PromoStylishDiscount({ promo, canEdit, onChanged }) {
  const markets = stylishMarkets(promo.marketplaces);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFromDiscount(promo.stylish_discount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!markets.length) return null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const built = buildStylishDiscount(draft, markets);
      if (built.error) throw new Error(built.error);
      await updatePromotionStylishDiscount(promo, built.discount);
      setEditing(false);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-2 text-body-sm">
        <StylishDiscountFields draft={draft} onChange={setDraft} markets={markets} />
        <span className="inline-flex items-center gap-3 flex-wrap">
          <button type="button" onClick={save} disabled={busy} className="px-3 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => { setDraft(draftFromDiscount(promo.stylish_discount)); setEditing(false); setError(null); }} disabled={busy} className="text-label-md font-medium text-on-surface-variant hover:underline">Cancel</button>
          {error && <span role="alert" className="text-error">{error}</span>}
        </span>
      </div>
    );
  }

  const d = promo.stylish_discount;
  const priced = d?.mode === 'price' ? markets.map((m) => `${MARKET[m].label} ${Object.keys(d.prices?.[m] ?? {}).length}`).join(' · ') : '';
  return (
    <div className="flex items-center gap-2 flex-wrap text-body-sm">
      <span className="text-label-lg text-on-surface-variant">Stylish discount</span>
      <span className="text-on-surface">
        {!d ? 'None set yet: nothing goes to the store' : d.mode === 'percent' ? `${d.percent}% off` : `By price: ${priced} products`}
      </span>
      {canEdit && <button type="button" onClick={() => setEditing(true)} className="text-label-md font-medium text-primary hover:underline">{d ? 'Change' : 'Set discount'}</button>}
    </div>
  );
}
