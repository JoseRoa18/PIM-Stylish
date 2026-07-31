import { supabase } from '@/lib/supabase';

// Channel registry — the single place a new connector is declared.
// `stat` returns the one number that tells the channel's health at a glance.
export const LIVE_CHANNELS = [
  {
    id: 'wix',
    name: 'Wix',
    tagline: 'Website catalog — import & push product data',
    letter: 'W',
    logo: '/brand/channels/wix.svg',
    avatarClass: 'bg-[#0C6EFC]/10 dark:bg-[#0C6EFC]/25 text-[#0C6EFC]',
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
  {
    id: 'bestbuy',
    name: 'Best Buy Canada',
    tagline: 'Mirakl marketplace — offers, stock & prices (read-only)',
    letter: 'B',
    logo: '/brand/channels/bestbuy.svg',
    avatarClass: 'bg-[#0046BE]/10 text-[#0046BE] dark:bg-[#0046BE]/30 dark:text-[#9DC2FF]',
    env: 'Read-only',
    envClass: 'bg-surface-container text-on-surface-variant',
    stat: async () => {
      const snap = await latestSnapshot('bestbuy');
      return snap
        ? { value: `${snap.in_sync}/${snap.total}`, label: 'offers active' }
        : { value: '—', label: 'no pull yet' };
    },
  },
  {
    id: 'walmart_us',
    name: 'Walmart US',
    tagline: 'Marketplace items & publish status (read-only)',
    letter: 'W',
    logo: '/brand/channels/walmart.svg',
    avatarClass: 'bg-[#0071CE]',
    env: 'Read-only',
    envClass: 'bg-surface-container text-on-surface-variant',
    stat: async () => {
      const snap = await latestSnapshot('walmart_us');
      return snap
        ? { value: `${snap.in_sync}/${snap.total}`, label: 'items published' }
        : { value: '—', label: 'no pull yet' };
    },
  },
  {
    id: 'walmart_ca',
    name: 'Walmart Canada',
    tagline: 'Presence via daily inventory feed (read-only)',
    letter: 'W',
    logo: '/brand/channels/walmart.svg',
    avatarClass: 'bg-[#0071CE]',
    env: 'Read-only',
    envClass: 'bg-surface-container text-on-surface-variant',
    stat: async () => {
      const snap = await latestSnapshot('walmart_ca');
      return snap
        ? { value: `${snap.total}`, label: 'SKUs in feed' }
        : { value: '—', label: 'no pull yet' };
    },
  },
];

// Latest channel_health snapshot for a channel (written by the read-only
// pulls); the directory reads it instead of hitting the live APIs.
export async function latestSnapshot(channel) {
  const { data } = await supabase
    .from('channel_health')
    .select('*')
    .eq('channel', channel)
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

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

