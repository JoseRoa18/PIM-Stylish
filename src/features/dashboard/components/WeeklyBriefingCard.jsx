import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarDays, CloudUpload, Hourglass, Link2Off, PackageX, RefreshCw, Tag } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { getBriefing, refreshBriefing } from '@/features/assistant/api/assistant';
import { formatTimeAgo } from '@/lib/format';

// The week's briefing (user, 2026-11-11: "Cada lunes: los más vendidos sin
// stock, promociones que empiezan, links rotos"). Built on the server every
// Monday at 7 AM Eastern straight from the data (assistantBriefing.js — no
// model writes it) and kept in app_settings 'assistant_briefing'; this card
// only shows it. Nothing is drawn until the first one exists. An admin can
// build it again now.
//
// The look (user, the same day, about a first version of three columns of
// sentences: "No me gusta como se ve eso"): the week's numbers as tiles, and a
// tile opens its detail under them — one at a time, pressed again it closes.

const KIND = { monthly: 'Monthly promotion', flash: 'Flash deal', mk_event: 'MK event', special: 'Peak Season event' };
const MARKETS = [['ca', 'Canada'], ['us', 'USA']];
// Why a product waits for Odoo (the reasons of odoo_pending).
const ODOO_REASON = {
  hs_not_listed: 'HS code not on Odoo’s list',
  archived: 'Archived in Odoo',
  not_in_odoo: 'Not in Odoo yet',
  several: 'Twice in Odoo',
  taken: 'UPC on another Odoo product',
  country_unknown: 'Country not in Odoo',
  refused: 'Odoo gave an error',
};
const PROMOS_SHOWN = 5;

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A bare day is that day where the person is (new Date() would read it as UTC).
function localDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
const shortDay = (iso) => localDay(iso)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) ?? String(iso ?? '');
function weekRange(from, to) {
  const a = localDay(from);
  const b = localDay(to);
  if (!a || !b) return shortDay(from);
  const month = (d) => d.toLocaleDateString('en-US', { month: 'long' });
  return a.getMonth() === b.getMonth() ? `${month(a)} ${a.getDate()} – ${b.getDate()}` : `${month(a)} ${a.getDate()} – ${month(b)} ${b.getDate()}`;
}

function Tile({ section, active, panelId, onToggle, className = '' }) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      aria-expanded={active}
      aria-controls={active ? panelId : undefined}
      onClick={onToggle}
      // The Dashboard's own tile (Marketplace Health); open, it takes the app's
      // "selected" look: the primary border over a primary tint.
      className={`flex flex-col text-left rounded-xl border px-3 sm:px-4 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        active ? 'border-primary bg-primary-container/30' : 'border-outline-variant bg-surface hover:border-primary'
      } ${className}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="text-body-md font-medium leading-tight text-on-surface">{section.label}</span>
        <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${section.tone}`} aria-hidden="true" />
      </span>
      <span className="mt-2.5 flex items-end gap-x-5 sm:gap-x-6 gap-y-2 flex-wrap">
        {section.figures.map((f) => (
          <span key={f.caption}>
            <span className="block text-headline-sm leading-none tabular-nums text-on-surface">{f.value}</span>
            <span className="block mt-1 text-label-md text-on-surface-variant">{f.caption}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

// What the numbers above mean and where to act on them: the card's footer
// strip, as on the Price Alignment card.
function PanelFoot({ children, to, linkLabel }) {
  return (
    <div className="-mx-6 -mb-5 mt-5 px-6 py-3 border-t border-outline-variant flex items-center justify-between gap-x-6 gap-y-1 flex-wrap">
      <p className="text-label-md text-on-surface-variant">{children}</p>
      {to && (
        <Link to={to} className="group inline-flex items-center gap-1 text-label-md text-primary">
          {linkLabel}
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

function ListHead({ title, note }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="text-label-lg text-on-surface">{title}</h3>
      <span className="text-label-md text-on-surface-variant">{note}</span>
    </div>
  );
}

function Arrival({ item }) {
  if (!item.arrives) return <span className="text-on-surface-variant">No date</span>;
  if (item.late) {
    return <span className="inline-block rounded px-1.5 py-0.5 text-label-sm whitespace-nowrap bg-warning-container text-on-warning-container">Was due {shortDay(item.arrives)}</span>;
  }
  return <span className="text-on-surface">{shortDay(item.arrives)}</span>;
}

const TH = 'py-1.5 font-medium text-right';
const TD = 'py-1.5 text-right tabular-nums text-on-surface';

// One market's products: what sells and has no stock, or what is about to run out.
function StockTable({ label, low, total, items }) {
  return (
    <div className="min-w-0">
      <ListHead title={label} note={total > items.length ? `top ${items.length} of ${total}` : count(total, 'product')} />
      {items.length === 0 ? (
        <p className="mt-2 text-body-sm text-on-surface-variant">{low ? 'Nothing is running low.' : 'Every product that sells has stock.'}</p>
      ) : (
        <table className="mt-1 w-full table-fixed text-body-sm" aria-label={`${label}: ${low ? 'running low' : 'selling, with no stock'}`}>
          <thead>
            <tr className="text-label-md text-on-surface-variant">
              <th scope="col" className="py-1.5 font-medium text-left">Product</th>
              {low && <th scope="col" className={`${TH} w-14 sm:w-16`}>In stock</th>}
              {low && <th scope="col" className={`${TH} w-16 sm:w-20`}>Lasts</th>}
              {!low && <th scope="col" className={`${TH} w-20`}>Sold 90 d</th>}
              <th scope="col" className={`${TH} w-24 hidden sm:table-cell`}>On order</th>
              <th scope="col" className={`${TH} w-24 sm:w-28`}>Arrives</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.sku} className="border-t border-outline-variant/60">
                <td className="py-1.5 pr-1 sm:pr-3 truncate">
                  <Link
                    to={`/catalog/${encodeURIComponent(item.sku)}`}
                    className="inline-block py-[3px] -my-[3px] text-label-lg text-on-surface hover:text-primary hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                  >
                    {item.sku}
                  </Link>
                  {item.model && <span className="hidden sm:inline ml-2 text-on-surface-variant">{item.model}</span>}
                </td>
                {low && <td className={TD}>{item.available}</td>}
                {low && <td className={TD}>{count(item.lasts_days, 'day')}</td>}
                {!low && <td className={TD}>{item.units_90}</td>}
                <td className={`${TD} hidden sm:table-cell`}>{item.on_order ?? <span className="text-on-surface-variant">—</span>}</td>
                <td className="py-1.5 text-right"><Arrival item={item} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StockPanel({ stock, low }) {
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-6">
        {MARKETS.map(([key, label]) => {
          const m = stock[key];
          if (!m) return null;
          return (
            <StockTable
              key={key}
              label={label}
              low={low}
              total={low ? m.running_low : m.out_of_stock}
              items={(low ? m.running_low_top : m.out_of_stock_top) ?? []}
            />
          );
        })}
      </div>
      <PanelFoot>
        {low
          ? 'Stock that lasts under 3 weeks at the pace of the last 90 days, the shortest first.'
          : 'Products sold in the last 90 days with no units available in that country, best sellers first.'}
      </PanelFoot>
    </>
  );
}

function PromoList({ title, empty, items }) {
  const shown = items.slice(0, PROMOS_SHOWN);
  return (
    <div className="min-w-0">
      <ListHead title={title} note={items.length > shown.length ? `${shown.length} of ${items.length}` : count(items.length, 'promotion')} />
      {shown.length === 0 ? (
        <p className="mt-2 text-body-sm text-on-surface-variant">{empty}</p>
      ) : (
        <ul className="mt-2 border-t border-outline-variant/60 divide-y divide-outline-variant/60">
          {shown.map((p, i) => (
            <li key={`${p.id}.${p.where}.${i}`} className="flex items-center gap-3 py-1.5">
              <span className="w-14 flex-shrink-0 rounded py-0.5 text-center text-label-md tabular-nums bg-surface-container-high text-on-surface-variant">{shortDay(p.day)}</span>
              <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
                <span className="block truncate text-label-lg text-on-surface sm:flex-1 sm:min-w-0" title={p.name}>{p.name}</span>
                <span className="block truncate text-label-md text-on-surface-variant sm:flex-none sm:max-w-[50%]">
                  {KIND[p.kind] ?? p.kind}{p.where ? ` · ${p.where}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PromotionsPanel({ promotions }) {
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-6">
        <PromoList title="Starting" empty="Nothing starts this week." items={promotions.starting ?? []} />
        <PromoList title="Ending" empty="Nothing ends this week." items={promotions.ending ?? []} />
      </div>
      <PanelFoot to="/pricing" linkLabel="Open Pricing">
        {count(promotions.running ?? 0, 'promotion')} running today, deals and events included.
      </PanelFoot>
    </>
  );
}

function LinksPanel({ links }) {
  const stores = links.by_store ?? [];
  const listed = stores.reduce((n, s) => n + s.broken, 0);
  const rows = [
    ...stores.map((s) => ({ label: s.store ?? s.retailer, n: s.broken })),
    ...(links.broken > listed ? [{ label: 'Other stores', n: links.broken - listed }] : []),
  ];
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <>
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-3" aria-label="Broken links by store">
        {rows.map((r) => (
          <li key={r.label}>
            <div className="flex items-center justify-between gap-2 text-label-md mb-1">
              <span className="text-on-surface-variant truncate">{r.label}</span>
              <span className="text-on-surface font-semibold tabular-nums">{r.n}</span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-container overflow-hidden" aria-hidden="true">
              <div className="h-full rounded-full bg-error/70" style={{ width: `${Math.max(3, (r.n / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <PanelFoot to="/listing-health?tab=where_to_buy" linkLabel="Open Where to Buy">
        Where to Buy links that no longer open the product. They stay off the websites until they are fixed.
      </PanelFoot>
    </>
  );
}

function OdooPanel({ odoo, isAdmin }) {
  const rows = Object.entries(odoo.by_reason ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <ul className="flex flex-wrap gap-x-10 gap-y-3" aria-label="Why they wait">
        {rows.map(([reason, n]) => (
          <li key={reason} className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center min-w-9 h-9 px-2 rounded-lg text-title-md font-semibold tabular-nums bg-warning-container text-on-warning-container">{n}</span>
            <span className="text-body-sm text-on-surface">{ODOO_REASON[reason] ?? String(reason).replace(/_/g, ' ')}</span>
          </li>
        ))}
      </ul>
      <PanelFoot to={isAdmin ? '/settings' : null} linkLabel="Open Settings">
        Saved in the PIM and not taken by Odoo yet. They are sent again every hour.
      </PanelFoot>
    </>
  );
}

export default function WeeklyBriefingCard() {
  const { isAdmin } = useAuth();
  const panelId = useId();
  const [briefing, setBriefing] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // One detail open at a time. On a phone the card starts closed: its tiles
  // already fill most of the screen.
  const [open, setOpen] = useState(() => (typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1024px)').matches ? 'out' : null));

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
  const { stock } = briefing;
  const promotions = briefing.promotions ?? {};
  const links = briefing.where_to_buy ?? {};
  const odoo = briefing.odoo ?? {};
  const perMarket = (field) => MARKETS.filter(([key]) => stock[key]).map(([key, label]) => ({ value: stock[key][field] ?? 0, caption: label }));

  const sections = [
    { key: 'out', label: 'Selling, no stock', icon: PackageX, tone: 'text-error', figures: perMarket('out_of_stock'), panel: <StockPanel stock={stock} /> },
    { key: 'low', label: 'Running low', icon: Hourglass, tone: 'text-warning', figures: perMarket('running_low'), panel: <StockPanel stock={stock} low /> },
    {
      key: 'promos',
      label: 'Promotions',
      icon: Tag,
      tone: 'text-on-surface-variant',
      figures: [{ value: promotions.starting?.length ?? 0, caption: 'starting' }, { value: promotions.ending?.length ?? 0, caption: 'ending' }],
      panel: <PromotionsPanel promotions={promotions} />,
    },
    {
      key: 'links',
      label: 'Broken links',
      icon: Link2Off,
      tone: 'text-error',
      figures: [{ value: links.broken ?? 0, caption: 'links' }, { value: links.products ?? 0, caption: 'products' }],
      panel: <LinksPanel links={links} />,
    },
    ...(odoo.waiting > 0
      ? [{
          key: 'odoo',
          label: 'Waiting for Odoo',
          icon: CloudUpload,
          tone: 'text-warning',
          figures: [{ value: odoo.waiting, caption: odoo.waiting === 1 ? 'product' : 'products' }],
          panel: <OdooPanel odoo={odoo} isAdmin={isAdmin} />,
        }]
      : []),
  ];
  const current = sections.find((s) => s.key === open) ?? null;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-2">
        <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap min-w-0">
          <CalendarDays className="w-4 h-4 text-on-surface-variant" aria-hidden="true" />
          <h2 className="text-title-md text-on-surface">This week</h2>
          <span className="text-label-md text-on-surface-variant">
            {weekRange(briefing.day, briefing.through)}
            {briefing.generated_at && <> · updated {formatTimeAgo(briefing.generated_at)}</>}
          </span>
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

      {/* Two across on a phone (an odd last tile takes the row), then as many as fit. */}
      <div className="px-6 py-5 grid gap-3 grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]">
        {sections.map((s, i) => (
          <Tile
            key={s.key}
            section={s}
            active={s.key === open}
            panelId={panelId}
            onToggle={() => setOpen(s.key === open ? null : s.key)}
            className={sections.length % 2 === 1 && i === sections.length - 1 ? 'col-span-2 sm:col-span-1' : ''}
          />
        ))}
      </div>

      {current && (
        <div id={panelId} className="px-6 py-5 border-t border-outline-variant">
          {current.panel}
        </div>
      )}
      {error && <p role="alert" className="px-6 pb-4 text-body-sm text-error">{error}</p>}
    </section>
  );
}
