import { supabase } from '@/lib/supabase';

// Channel registry — the single place a new connector is declared.
// `stat` returns the one number that tells the channel's health at a glance.
export const LIVE_CHANNELS = [
  {
    id: 'wix',
    name: 'Wix',
    tagline: 'Website catalog — import & push product data',
    letter: 'W',
    avatarClass: 'bg-inverse-surface text-on-inverse-surface',
    env: 'Production',
    envClass: 'bg-success-container text-on-success-container',
    stat: async (totals) => {
      const { count } = await supabase
        .from('products')
        .select('sku', { count: 'exact', head: true })
        .not('wix_product_id', 'is', null);
      return { value: `${count ?? 0}/${totals.products}`, label: 'products linked' };
    },
  },
  {
    id: 'wayfair',
    name: 'Wayfair',
    tagline: 'Content, images & spec attributes — CA and US suppliers',
    letter: 'W',
    avatarClass: 'bg-[#7B189F]/15 text-[#7B189F] dark:bg-[#7B189F]/30 dark:text-[#CE93E8]',
    env: 'Sandbox',
    envClass: 'bg-warning-container text-on-warning-container',
    stat: async (totals) => {
      const { count } = await supabase
        .from('products')
        .select('sku', { count: 'exact', head: true })
        .not('wayfair_item_group_id', 'is', null);
      return { value: `${count ?? 0}/${totals.products}`, label: 'item groups linked' };
    },
  },
];

// Channels served by filled template files rather than a live API. They live
// on the Templates page; the directory lists them so Syndication shows the
// whole channel landscape in one place.
export async function loadFileChannels() {
  const { data } = await supabase.from('marketplace_templates').select('marketplace');
  const counts = new Map();
  for (const row of data ?? []) counts.set(row.marketplace, (counts.get(row.marketplace) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([marketplace, templates]) => ({ marketplace, templates }));
}

export async function loadTotals() {
  const { count } = await supabase.from('products').select('sku', { count: 'exact', head: true });
  return { products: count ?? 0 };
}
