import { useEffect, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { supabase } from '@/lib/supabase';
import { WIX_SITES, WIX_SITE_KEYS, wixSiteSells } from '../lib/wixSites';
import { isExcluded, wixExclusionKey } from '../lib/marketplaces';

/**
 * The catalog's "Push to Wix" for a selection (user, 2026-11-05: it only ever
 * updated Sinks Direct Canada's content). Lists the five Wix stores with how
 * many of the selected products each would get — a store that never carries
 * a product's brand, or one the product is switched off for, is left out — and
 * pushes everything the PIM has to the stores picked, as each product's own
 * "Push <store>" does. A product not on a store yet is skipped (created from
 * its page, never by a bulk push). `onPush([{ sku, site }])` runs the pushes.
 */
export default function WixStoresPushDialog({ skus, onClose, onPush }) {
  const [plan, setPlan] = useState(null); // { [site]: { push: [sku], missing: [sku] } }
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(() => new Set());

  useEffect(() => {
    let active = true;
    (async () => {
      const products = [];
      const links = [];
      for (let i = 0; i < skus.length; i += 150) {
        const part = skus.slice(i, i + 150);
        const [{ data: p, error: e1 }, { data: l, error: e2 }] = await Promise.all([
          supabase.from('products').select('sku, brand, channel_exclusions, wix_product_id').in('sku', part),
          supabase.from('wix_links').select('sku, site').in('sku', part),
        ]);
        if (e1 || e2) throw e1 ?? e2;
        products.push(...(p ?? []));
        links.push(...(l ?? []));
      }
      const linked = new Set(links.map((l) => `${l.site}|${l.sku}`));
      const out = {};
      for (const site of WIX_SITE_KEYS) {
        const sells = products.filter((p) => wixSiteSells(site, p) && !isExcluded(p, wixExclusionKey(site)));
        const on = (p) => linked.has(`${site}|${p.sku}`) || (site === 'sinksdirect_ca' && Boolean(p.wix_product_id));
        out[site] = { push: sells.filter(on).map((p) => p.sku), missing: sells.filter((p) => !on(p)).map((p) => p.sku) };
      }
      if (!active) return;
      setPlan(out);
      setPicked(new Set(WIX_SITE_KEYS.filter((s) => out[s].push.length)));
    })().catch((err) => { if (active) setError(err.message ?? String(err)); });
    return () => { active = false; };
  }, [skus]);

  const pairs = plan ? WIX_SITE_KEYS.filter((s) => picked.has(s)).flatMap((site) => plan[site].push.map((sku) => ({ sku, site }))) : [];
  const toggle = (site) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(site)) next.delete(site); else next.add(site);
    return next;
  });
  // ~30 s a push (content, then the gallery); two at a time.
  const minutes = Math.max(1, Math.round((pairs.length * 30) / 2 / 60));

  return (
    <Dialog
      onClose={onClose}
      title="Push to Wix stores"
      subtitle={`${skus.length} selected product${skus.length === 1 ? '' : 's'}. Each one gets everything the PIM has, as its own "Push <store>" sends it.`}
      maxWidth="max-w-xl"
      footer={(
        <>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">Cancel</button>
          <button
            type="button"
            disabled={!pairs.length}
            onClick={() => onPush(pairs)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="w-3.5 h-3.5" aria-hidden />
            {pairs.length ? `Push ${pairs.length} (${picked.size} store${picked.size === 1 ? '' : 's'})` : 'Push'}
          </button>
        </>
      )}
    >
      {error ? (
        <p role="alert" className="text-body-sm text-error">{error}</p>
      ) : !plan ? (
        <p role="status" className="flex items-center gap-2 text-body-sm text-on-surface-variant"><Loader2 className="w-4 h-4 animate-spin" aria-hidden />Reading where each product is…</p>
      ) : (
        <div className="space-y-4">
          <fieldset>
            <legend className="text-label-md text-on-surface-variant mb-2">Stores</legend>
            <ul className="space-y-1.5">
              {WIX_SITE_KEYS.map((site) => {
                const p = plan[site];
                const none = !p.push.length;
                return (
                  <li key={site}>
                    <label className={`flex items-start gap-3 rounded-xl border border-outline-variant px-3 py-2.5 ${none ? 'opacity-60' : 'cursor-pointer hover:bg-surface-container-low'}`}>
                      <input type="checkbox" className="mt-1 w-4 h-4 accent-primary" checked={picked.has(site)} disabled={none} onChange={() => toggle(site)} />
                      <span className="min-w-0">
                        <span className="block text-body-md text-on-surface">{WIX_SITES[site].label}</span>
                        <span className="block text-body-sm text-on-surface-variant">
                          {p.push.length} product{p.push.length === 1 ? '' : 's'}
                          {p.missing.length > 0 && ` · ${p.missing.length} not on this store yet (${p.missing.slice(0, 4).join(', ')}${p.missing.length > 4 ? '…' : ''}) — skipped`}
                          {none && !p.missing.length && ' — none of the selected products is sold here'}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <p className="text-body-sm text-on-surface-variant">
            The content (description auto-formatted, prices, weight — never the name), the info sections rebuilt from the PIM and the whole gallery; the Stylish and Azuni pages also get their Where to Buy. A store that never carries a product&apos;s brand, or one it is switched off for, is left out. A product not on a store yet is skipped: create it from its page.
            {pairs.length > 0 && ` About ${minutes} minute${minutes === 1 ? '' : 's'} — the progress card shows it, and the page can be left.`}
          </p>
        </div>
      )}
    </Dialog>
  );
}
