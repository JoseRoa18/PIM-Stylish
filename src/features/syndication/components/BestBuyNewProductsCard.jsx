import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { checkBestBuyListings, loadBestBuyCandidates } from '../api/bestbuySync';

const money = (n) => (n == null ? '—' : `C$${Number(n).toFixed(2)}`);

// Where each one stands, in the order a person works them.
function standing(c) {
  const status = c.listing?.status;
  if (status === 'in_review') return { key: 'waiting', label: "In Best Buy's review" };
  if (status === 'offer_sent') return { key: 'waiting', label: 'Offer sent, waiting for Best Buy' };
  if (c.mismatch) return { key: 'blocked', label: 'Its UPC is another product on Best Buy', detail: c.catalog?.title };
  if (c.catalog) return { key: 'offer', label: 'Ready for its offer', detail: c.catalog.title };
  if (status === 'refused') return { key: 'blocked', label: 'Best Buy refused it', detail: c.listing.note };
  if (c.problems.length) return { key: 'blocked', label: `The PIM lacks: ${c.problems.join('; ')}` };
  return { key: 'create', label: 'Not in the catalog: create the product' };
}
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'offer', label: 'Ready for its offer' },
  { key: 'create', label: 'To create' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'blocked', label: 'Blocked' },
];

// The PIM's products with no offer on Best Buy, to choose from (user, 2026-11-06:
// "yo elijo qué oferta crear"). Nothing is sent from here: a row opens the product,
// whose Marketplaces tab creates the product or its offer.
export default function BestBuyNewProductsCard() {
  const { canEdit } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let active = true;
    (async () => {
      // How Best Buy answered since the last look; an offer asked for with a product goes once approved.
      if (canEdit) await checkBestBuyListings().catch(() => {});
      const list = await loadBestBuyCandidates();
      if (active) setRows(list.map((c) => ({ ...c, standing: standing(c) })));
    })().catch((err) => { if (active) setError(err.message ?? String(err)); });
    return () => { active = false; };
  }, [canEdit]);

  const counts = useMemo(() => {
    const m = { all: rows?.length ?? 0 };
    for (const r of rows ?? []) m[r.standing.key] = (m[r.standing.key] ?? 0) + 1;
    return m;
  }, [rows]);
  const shown = (rows ?? []).filter((r) => filter === 'all' || r.standing.key === filter);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant">
        <h2 className="text-title-md text-on-surface">Products not on Best Buy</h2>
        <p className="text-body-sm text-on-surface-variant mt-0.5">
          Open a product and, on its Marketplaces tab, create the product or its offer. Products switched off for Best Buy are left out. An offer asked for with a product goes once Best Buy approves it: the PIM looks every hour.
        </p>
      </header>
      <div className="px-6 py-5 space-y-4">
        {error && <p role="alert" className="text-body-sm text-error">{error}</p>}
        {!rows && !error && (
          <p role="status" className="text-body-sm text-on-surface-variant inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            Reading Best Buy…
          </p>
        )}
        {rows && (
          <>
            <div role="group" aria-label="Filter by where they stand" className="flex items-center gap-1.5 flex-wrap">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={`px-3 py-1 rounded-full text-label-md border transition-colors ${filter === f.key ? 'bg-primary text-on-primary border-primary' : 'bg-surface border-outline-variant text-on-surface hover:bg-surface-container-low'}`}
                >
                  {f.label} ({counts[f.key] ?? 0})
                </button>
              ))}
            </div>
            {shown.length === 0 ? (
              <p className="text-body-sm text-on-surface-variant">No product here.</p>
            ) : (
              <div className="overflow-auto max-h-[60vh] rounded-xl border border-outline-variant" data-lenis-prevent tabIndex={0} role="region" aria-label="Products not on Best Buy">
                <table className="w-full text-body-sm">
                  <thead>
                    <tr className="text-on-surface-variant text-label-md">
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-left px-4 py-2.5 font-medium">SKU</th>
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-left px-4 py-2.5 font-medium">Product</th>
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-right px-4 py-2.5 font-medium">MAP Blue</th>
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-right px-4 py-2.5 font-medium">Stock CA</th>
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-left px-4 py-2.5 font-medium">Where it stands</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.sku} className="border-t border-outline-variant/40">
                        <td className="px-4 py-2 whitespace-nowrap">
                          <Link to={`/catalog/${r.sku}`} className="font-mono text-primary hover:underline">{r.sku}</Link>
                        </td>
                        <td className="px-4 py-2 text-on-surface">{r.model ?? '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-on-surface whitespace-nowrap">{money(r.price)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-on-surface">{r.tracked ? r.quantity : 'Not tracked'}</td>
                        <td className="px-4 py-2">
                          <span className="text-on-surface">{r.standing.label}</span>
                          {r.standing.detail && <span className="block text-on-surface-variant">{r.standing.detail}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
