// Per-product marketplace exclusions (rule 2026-09-22) — Deno mirror of
// src/features/syndication/lib/marketplaces.js. products.channel_exclusions
// holds the keys a product is switched off for: no pushes, listings, files
// or promos there. Keys: wix_<site>, wayfair_ca, wayfair_us, bestbuy,
// walmart_ca, walmart_us, amazon_ca, amazon_us, homedepot_ca, homedepot_us,
// lowes_us, menards, bbb, rona.

export const EXCLUSION_LABEL: Record<string, string> = {
  wix_sinksdirect_ca: "Sinks Direct Canada", wix_sinksdirect_us: "Sinks Direct USA", wix_stylish_ca: "Stylish Canada",
  wix_stylish_us: "Stylish USA", wix_azuni_ca: "Azuni Canada", wayfair_ca: "Wayfair Canada", wayfair_us: "Wayfair USA",
  bestbuy: "Best Buy Canada", walmart_ca: "Walmart Canada", walmart_us: "Walmart USA", amazon_ca: "Amazon Canada",
  amazon_us: "Amazon USA", homedepot_ca: "Home Depot Canada", homedepot_us: "Home Depot USA", lowes_us: "Lowe's USA",
  menards: "Menards", bbb: "BB&B / Overstock", rona: "Rona",
};

export const isExcluded = (row: { channel_exclusions?: string[] | null } | null | undefined, key: string): boolean =>
  Array.isArray(row?.channel_exclusions) && row!.channel_exclusions!.includes(key);

/** The message a push returns when the product is switched off for the marketplace. */
export const excludedMessage = (sku: string, key: string): string =>
  `${sku} is excluded from ${EXCLUSION_LABEL[key] ?? key} (switched off on the product's Marketplaces tab) — nothing is sent there.`;

// deno-lint-ignore no-explicit-any
type Client = { from: (t: string) => any };

/** Among `skus`, the ones switched off for `key` (supabase-js client). */
export async function excludedSet(client: Client, skus: string[], key: string): Promise<Set<string>> {
  const out = new Set<string>();
  const list = [...new Set(skus)];
  for (let i = 0; i < list.length; i += 200) {
    const { data } = await client.from("products").select("sku").contains("channel_exclusions", [key]).in("sku", list.slice(i, i + 200));
    for (const p of (data ?? []) as { sku: string }[]) out.add(p.sku);
  }
  return out;
}
