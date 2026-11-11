import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { getBriefing, refreshBriefing } from '@/features/assistant/api/assistant';
import { formatDate } from '@/lib/format';

// The week's briefing (user, 2026-11-11: "Cada lunes: los más vendidos sin
// stock, promociones que empiezan, links rotos"). Built on the server every
// Monday at 7 AM Eastern straight from the data (assistantBriefing.js — no
// model writes it) and kept in app_settings 'assistant_briefing'; this card
// only shows it. Nothing is drawn until the first one exists. An admin can
// build it again now.

const KIND = { monthly: 'Monthly promotion', flash: 'Flash deal', mk_event: 'MK event', special: 'Peak Season event' };
const MARKETS = [['ca', 'Canada'], ['us', 'USA']];
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso) => formatDate(iso)?.replace(/,? \d{4}$/, '') ?? iso;

function SkuLine({ item, children }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <Link to={`/catalog/${encodeURIComponent(item.sku)}`} className="inline-block py-[3px] -my-[3px] text-primary underline underline-offset-2 font-medium">{item.sku}</Link>
      <span className="text-on-surface-variant">{children}</span>
    </li>
  );
}

const arrival = (item) => (item.arrives ? `${item.late ? 'was due' : 'arrives'} ${day(item.arrives)}` : 'no arrival date');

function PromoList({ title, items }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-label-lg font-medium text-on-surface">{title}</h4>
      <ul className="mt-1 space-y-1 text-body-sm">
        {items.slice(0, 3).map((p, i) => (
          <li key={`${p.id}.${p.where}.${i}`} className="text-on-surface-variant [overflow-wrap:anywhere]">
            <span className="text-on-surface">{day(p.day)}</span> · {p.name} <span className="text-label-sm">({KIND[p.kind] ?? p.kind}{p.where ? `, ${p.where}` : ''})</span>
          </li>
        ))}
        {items.length > 3 && <li className="text-on-surface-variant">and {items.length - 3} more</li>}
      </ul>
    </div>
  );
}

export default function WeeklyBriefingCard() {
  const { isAdmin } = useAuth();
  const [briefing, setBriefing] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    getBriefing().then((value) => { if (active) setBriefing(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      setBriefing(await refreshBriefing());
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  }

  if (!briefing?.stock) return null;
  const { stock, promotions, where_to_buy: links, odoo } = briefing;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarDays className="w-4 h-4 text-on-surface-variant" aria-hidden="true" />
          <h2 className="text-title-md text-on-surface">This week</h2>
          <span className="text-label-md text-on-surface-variant">as of {formatDate(briefing.day)} · through {day(briefing.through)}</span>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Build this week's briefing again"
            title="Build it again now"
            className="p-2 -m-1 rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-3 gap-x-8 gap-y-6">
        <div className="space-y-4">
          <h3 className="text-label-lg font-semibold text-on-surface">Selling, with no stock</h3>
          {MARKETS.map(([key, label]) => {
            const m = stock[key];
            if (!m) return null;
            return (
              <div key={key}>
                <h4 className="text-label-lg font-medium text-on-surface">{label}: {count(m.out_of_stock, 'product')}</h4>
                <ul className="mt-1 space-y-1 text-body-sm">
                  {m.out_of_stock_top.slice(0, 3).map((item) => (
                    <SkuLine key={item.sku} item={item}>{item.units_90} sold in 90 days · {arrival(item)}</SkuLine>
                  ))}
                  {m.out_of_stock === 0 && <li className="text-on-surface-variant">Every product that sells has stock.</li>}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="space-y-4">
          <h3 className="text-label-lg font-semibold text-on-surface">Running low</h3>
          {MARKETS.map(([key, label]) => {
            const m = stock[key];
            if (!m) return null;
            return (
              <div key={key}>
                <h4 className="text-label-lg font-medium text-on-surface">{label}: {count(m.running_low, 'product')} under 3 weeks</h4>
                <ul className="mt-1 space-y-1 text-body-sm">
                  {m.running_low_top.slice(0, 3).map((item) => (
                    <SkuLine key={item.sku} item={item}>{count(item.available, 'unit')} · lasts {count(item.lasts_days, 'day')} · {arrival(item)}</SkuLine>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="space-y-4">
          <h3 className="text-label-lg font-semibold text-on-surface">
            <Link to="/pricing" className="underline underline-offset-2">Promotions</Link>: {promotions.running} running
          </h3>
          <PromoList title="Starting" items={promotions.starting} />
          <PromoList title="Ending" items={promotions.ending} />
          <div className="text-body-sm text-on-surface-variant space-y-1">
            <p>
              <Link to="/listing-health" className="text-primary underline underline-offset-2">Where to Buy</Link>: {count(links.broken, 'broken link')} on {count(links.products, 'product')}
              {links.by_store.length > 0 && ` — ${links.by_store.slice(0, 3).map((s) => `${s.store ?? s.retailer} ${s.broken}`).join(', ')}`}.
            </p>
            {odoo.waiting > 0 && (
              <p>{isAdmin ? <Link to="/settings" className="text-primary underline underline-offset-2">Odoo</Link> : 'Odoo'}: {count(odoo.waiting, 'product')} waiting to be sent.</p>
            )}
          </div>
        </div>
      </div>
      {error && <p role="alert" className="px-6 pb-4 text-body-sm text-error">{error}</p>}
    </section>
  );
}
