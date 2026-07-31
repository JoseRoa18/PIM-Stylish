import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ScanSearch, ChevronDown, CheckCircle2, AlertCircle, Barcode, Type, Tag, PackageX,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatTimeAgo, formatCategory } from '@/lib/format';
import { latestSnapshot } from '../lib/channels';

// Normalize for title comparison: case, punctuation and spacing noise out.
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[""'’·×]/g, '"')
    .replace(/[^a-z0-9"]+/g, ' ')
    .trim();

/**
 * Read-only catalog audit — PIM vs what Best Buy actually lists.
 * Everything is computed from the latest offers snapshot (which carries
 * category / title / brand / UPC per SKU) against the PIM. Nothing is
 * written anywhere; this is the map for the future content push.
 */
export default function BestBuyCatalogAuditCard() {
  const [snap, setSnap] = useState(undefined);
  const [products, setProducts] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null); // which section is expanded

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [snapshot, { data: prods, error: prodErr }] = await Promise.all([
          latestSnapshot('bestbuy'),
          supabase
            .from('products')
            .select('sku, category, brand, model_name, upc:attributes->>upc, title:attributes->>general_title_en'),
        ]);
        if (prodErr) throw prodErr;
        if (active) {
          setSnap(snapshot);
          setProducts(prods ?? []);
        }
      } catch (err) {
        if (active) setError(err.message);
      }
    })();
    return () => { active = false; };
  }, []);

  const audit = useMemo(() => {
    if (!snap?.results || !products) return null;
    // Old snapshots predate the product fields — ask for a fresh pull.
    if (!snap.results.some((o) => o.category_label || o.product_title)) return { stale: true };

    const bySku = new Map(products.map((p) => [p.sku, p]));
    const offerSkus = new Set(snap.results.map((o) => o.sku));

    const matched = [];
    const offersWithoutPim = [];
    for (const o of snap.results) {
      const p = bySku.get(o.sku);
      if (p) matched.push({ offer: o, pim: p });
      else offersWithoutPim.push(o);
    }
    const pimWithoutOffer = products.filter((p) => !offerSkus.has(p.sku));

    const upcMismatches = matched.filter(
      ({ offer, pim }) => offer.upc && pim.upc && offer.upc !== pim.upc,
    );
    const brandMismatches = matched.filter(
      ({ offer, pim }) => offer.product_brand && pim.brand && norm(offer.product_brand) !== norm(pim.brand),
    );
    const titleMismatches = matched.filter(
      ({ offer, pim }) => offer.product_title && pim.title && norm(offer.product_title) !== norm(pim.title),
    );

    // PIM category × Best Buy category cross-tab.
    const matrix = new Map();
    for (const { offer, pim } of matched) {
      const key = `${pim.category ?? '—'}|${offer.category_label ?? '—'}`;
      matrix.set(key, (matrix.get(key) ?? 0) + 1);
    }
    const categoryRows = [...matrix.entries()]
      .map(([key, count]) => {
        const [pimCat, bbCat] = key.split('|');
        return { pimCat, bbCat, count };
      })
      .sort((a, b) => b.count - a.count);

    return {
      stale: false,
      matchedCount: matched.length,
      offersWithoutPim,
      pimWithoutOffer,
      upcMismatches,
      brandMismatches,
      titleMismatches,
      categoryRows,
    };
  }, [snap, products]);

  const toggle = (key) => setOpen(open === key ? null : key);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center gap-2 flex-wrap">
        <ScanSearch className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-md text-on-surface">Catalog Audit</h2>
        <span className="text-label-md text-on-surface-variant">
          PIM vs Best Buy — read-only
          {snap?.run_at && <span> · snapshot {formatTimeAgo(snap.run_at)}</span>}
        </span>
      </header>

      <div className="px-6 py-5 space-y-4">
        {error && (
          <p className="px-3 py-2 rounded-lg bg-error-container text-on-error-container text-body-sm">{error}</p>
        )}

        {snap === undefined || (!audit && !error) ? (
          <p className="text-body-sm text-on-surface-variant">Loading audit…</p>
        ) : snap === null ? (
          <p className="text-body-sm text-on-surface-variant">
            No offers snapshot yet — run "Refresh now" above first.
          </p>
        ) : audit?.stale ? (
          <p className="text-body-sm text-on-surface-variant">
            The latest snapshot predates the audit fields. Hit "Refresh now"
            above once and reload this page.
          </p>
        ) : audit && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Matched SKUs" value={audit.matchedCount} />
              <Stat label="UPC mismatches" value={audit.upcMismatches.length} bad={audit.upcMismatches.length > 0} />
              <Stat label="Brand mismatches" value={audit.brandMismatches.length} bad={audit.brandMismatches.length > 0} />
              <Stat label="Title differences" value={audit.titleMismatches.length} bad={audit.titleMismatches.length > 0} />
            </div>

            <AuditSection
              id="upc"
              open={open}
              toggle={toggle}
              icon={Barcode}
              title={`UPC mismatches · ${audit.upcMismatches.length}`}
              intro="The barcode on the live listing differs from the PIM UPC — a hard data error worth fixing first."
              empty="Every matched listing's UPC agrees with the PIM."
              items={audit.upcMismatches}
              render={({ offer, pim }) => (
                <Row sku={pim.sku} left={`BB: ${offer.upc}`} right={`PIM: ${pim.upc}`} />
              )}
            />

            <AuditSection
              id="brand"
              open={open}
              toggle={toggle}
              icon={Tag}
              title={`Brand mismatches · ${audit.brandMismatches.length}`}
              intro="The listing shows a different brand than the PIM."
              empty="All matched listings carry the PIM brand."
              items={audit.brandMismatches}
              render={({ offer, pim }) => (
                <Row sku={pim.sku} left={`BB: ${offer.product_brand}`} right={`PIM: ${pim.brand}`} />
              )}
            />

            <AuditSection
              id="title"
              open={open}
              toggle={toggle}
              icon={Type}
              title={`Title differences · ${audit.titleMismatches.length}`}
              intro="The live title differs from the PIM marketing title (EN). Some divergence is normal; big gaps are content-push candidates."
              empty="All matched listings use the PIM marketing title."
              items={audit.titleMismatches}
              render={({ offer, pim }) => (
                <Row sku={pim.sku} left={`BB: ${offer.product_title}`} right={`PIM: ${pim.title}`} stacked />
              )}
            />

            <AuditSection
              id="coverage"
              open={open}
              toggle={toggle}
              icon={PackageX}
              title={`Coverage · ${audit.pimWithoutOffer.length} PIM products without offer · ${audit.offersWithoutPim.length} offers unknown to the PIM`}
              intro="Unlisted PIM products are expansion opportunities; unknown offers are mostly open-box (-B-OB-A) and retired SKUs."
              empty="Full overlap."
              items={[
                ...audit.pimWithoutOffer.map((p) => ({ kind: 'pim', p })),
                ...audit.offersWithoutPim.map((o) => ({ kind: 'offer', o })),
              ]}
              render={(item) =>
                item.kind === 'pim' ? (
                  <Row sku={item.p.sku} left={item.p.model_name ?? ''} right="not listed on Best Buy" />
                ) : (
                  <li className="flex items-center justify-between gap-3 text-body-sm py-1">
                    <span className="font-mono text-on-surface">{item.o.sku}</span>
                    <span className="text-on-surface-variant truncate">{item.o.product_title ?? 'offer without PIM product'}</span>
                  </li>
                )
              }
            />

            {/* Category cross-tab: a report, not an error list — Best Buy's
                taxonomy has no sink categories, so "closest available" is
                often the only option. */}
            <div className="border-t border-outline-variant pt-4">
              <h3 className="text-label-md text-on-surface-variant mb-2">
                Where the catalog lives at Best Buy (PIM category → Best Buy category)
              </h3>
              <div className="overflow-x-auto rounded-xl border border-outline-variant">
                <table className="w-full text-body-sm">
                  <thead className="bg-surface-container-low text-left text-label-md text-on-surface-variant">
                    <tr>
                      <th className="px-3 py-2">PIM category</th>
                      <th className="px-3 py-2">Best Buy category</th>
                      <th className="px-3 py-2 text-right">SKUs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant">
                    {audit.categoryRows.map((r) => (
                      <tr key={`${r.pimCat}|${r.bbCat}`}>
                        <td className="px-3 py-2 text-on-surface">{formatCategory(r.pimCat)}</td>
                        <td className="px-3 py-2 text-on-surface-variant">{r.bbCat}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-on-surface">{r.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, bad = false }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface px-4 py-3">
      <div className={`text-title-lg font-semibold leading-tight tabular-nums ${bad ? 'text-error' : 'text-on-surface'}`}>
        {value}
      </div>
      <div className="text-label-md text-on-surface-variant mt-1">{label}</div>
    </div>
  );
}

function AuditSection({ id, open, toggle, icon: Icon, title, intro, empty, items, render }) {
  const expanded = open === id;
  return (
    <div className="rounded-xl border border-outline-variant overflow-hidden">
      <button
        type="button"
        onClick={() => toggle(id)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface-container-low/40 transition-colors"
      >
        <Icon className="w-4 h-4 text-on-surface-variant flex-shrink-0" />
        <span className="text-body-md text-on-surface font-medium flex-1">{title}</span>
        {items.length === 0 ? (
          <CheckCircle2 className="w-4 h-4 text-success" />
        ) : (
          <AlertCircle className="w-4 h-4 text-warning" />
        )}
        <ChevronDown className={`w-4 h-4 text-on-surface-variant transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="px-4 pb-3 border-t border-outline-variant">
          <p className="text-label-md text-on-surface-variant py-2">{items.length === 0 ? empty : intro}</p>
          {items.length > 0 && (
            <ul className="max-h-72 overflow-y-auto divide-y divide-outline-variant/60">
              {items.map((item, i) => (
                <li key={i}>{render(item)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ sku, left, right, stacked = false }) {
  return (
    <div className={`py-1.5 text-body-sm ${stacked ? 'space-y-0.5' : 'flex items-center justify-between gap-3'}`}>
      <Link to={`/catalog/${encodeURIComponent(sku)}`} className="font-mono text-primary hover:underline">
        {sku}
      </Link>
      {stacked ? (
        <>
          <p className="text-on-surface-variant truncate">{left}</p>
          <p className="text-on-surface truncate">{right}</p>
        </>
      ) : (
        <>
          <span className="text-on-surface-variant truncate">{left}</span>
          <span className="text-on-surface truncate">{right}</span>
        </>
      )}
    </div>
  );
}
