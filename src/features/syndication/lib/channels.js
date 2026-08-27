import { supabase } from '@/lib/supabase';

// Channel registry — the single place a new connector is declared.
// `stat` returns the one number that tells the channel's health at a glance.
// `env` is the environment (Production/Sandbox); the optional `mode` chip
// carries the access mode (Read-only) so the two concepts never share a slot.
export const LIVE_CHANNELS = [
  {
    id: 'wix',
    name: 'Wix',
    tagline: 'Website catalog — import & push product data',
    letter: 'W',
    logo: '/brand/channels/wix.svg',
    avatarClass: 'bg-brand-wix/10 text-brand-wix',
    env: 'Production',
    envClass: 'bg-success-container text-on-success-container',
    stat: async (totals) => {
      // Prefer the fleet snapshot (live on site); fall back to the linked
      // count for installs that haven't pulled yet.
      const snap = await latestSnapshot('wix');
      if (snap) return { value: `${snap.in_sync}/${snap.total}`, label: 'live on site' };
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
    letter: 'WF', // no logo asset in the repo — two-letter monogram keeps it apart from Wix's W
    avatarClass: 'bg-brand-wayfair/15 text-brand-wayfair',
    env: 'Production',
    envClass: 'bg-success-container text-on-success-container',
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
    tagline: 'Mirakl marketplace — offers, stock & prices',
    letter: 'BB', // the price-tag SVG is illegible at tile size — monogram instead
    avatarClass: 'bg-brand-bestbuy/10 text-brand-bestbuy',
    env: 'Production',
    envClass: 'bg-success-container text-on-success-container',
    mode: 'Read-only',
    modeClass: 'bg-surface-container-highest text-on-surface-variant border border-outline-variant',
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
    tagline: 'Marketplace items & publish status',
    letter: 'W',
    logo: '/brand/channels/walmart.svg',
    avatarClass: 'bg-brand-walmart/10 text-brand-walmart',
    env: 'Production',
    envClass: 'bg-success-container text-on-success-container',
    mode: 'Read-only',
    modeClass: 'bg-surface-container-highest text-on-surface-variant border border-outline-variant',
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
    tagline: 'Presence via daily inventory feed',
    letter: 'W',
    logo: '/brand/channels/walmart.svg',
    avatarClass: 'bg-brand-walmart/10 text-brand-walmart',
    env: 'Production',
    envClass: 'bg-success-container text-on-success-container',
    mode: 'Read-only',
    modeClass: 'bg-surface-container-highest text-on-surface-variant border border-outline-variant',
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

