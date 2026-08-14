// The four Wix sites of the account, all reachable with the ONE account-level
// WIX_API_KEY — only the wix-site-id header changes. Site ids are stable
// public identifiers, not secrets. WIX_SITE_ID (env) remains the SinksDirect
// Canada id and wins for that site if it's ever moved.
//
// priceField: which PIM column is the site's selling price. Verified against
// the live catalogs 2026-08-14: SinksDirect sites sell at MAP, Stylish brand
// sites sell at MSRP (290/299 resp. 291/295 resp. 206/211 exact matches).
//
// Keep this registry in sync with src/features/syndication/lib/wixSites.js.

export interface WixSite {
  key: string;
  label: string;
  siteId: string;
  currency: "CAD" | "USD";
  priceField: "map_cad" | "map_usd" | "msrp_cad" | "msrp_usd";
  market: "ca" | "us";
  /** channel_health channel key for this site's snapshots ('wix' = legacy CA). */
  channel: string;
  /** SinksDirect sites follow the monthly promo (expected = promo ?? base and
   *  the discounted price counts); Stylish brand sites run their own sales,
   *  so only the base price is compared against MSRP. */
  promoAware: boolean;
  /** Only SinksDirect CA keeps the legacy products.* link/cache columns. */
  legacyColumns: boolean;
  /** PIM sale fields (on_sale / sale_price_cad) are CAD — only pushed here. */
  hasSale: boolean;
  /** wix_collection_ids stores SinksDirect CA collection GUIDs only. */
  hasCollections: boolean;
}

export const WIX_SITES: Record<string, WixSite> = {
  sinksdirect_ca: {
    key: "sinksdirect_ca",
    channel: "wix",
    promoAware: true,
    label: "Sinks Direct Canada",
    siteId: Deno.env.get("WIX_SITE_ID") ?? "a4b3f611-7e41-4b75-93df-f869cf376e0c",
    currency: "CAD",
    priceField: "map_cad",
    market: "ca",
    legacyColumns: true,
    hasSale: true,
    hasCollections: true,
  },
  sinksdirect_us: {
    key: "sinksdirect_us",
    channel: "wix_sinksdirect_us",
    promoAware: true,
    label: "Sinks Direct USA",
    siteId: "bf567955-60ed-4ca8-9a5c-89810dc6fbcf",
    currency: "USD",
    priceField: "map_usd",
    market: "us",
    legacyColumns: false,
    hasSale: false,
    hasCollections: false,
  },
  stylish_ca: {
    key: "stylish_ca",
    channel: "wix_stylish_ca",
    promoAware: false,
    label: "Stylish Canada",
    siteId: "2c055557-06fe-401c-b0b7-9593c6e5a34e",
    currency: "CAD",
    priceField: "msrp_cad",
    market: "ca",
    legacyColumns: false,
    hasSale: false,
    hasCollections: false,
  },
  stylish_us: {
    key: "stylish_us",
    channel: "wix_stylish_us",
    promoAware: false,
    label: "Stylish USA",
    siteId: "467de3bb-6702-4201-a816-a4fbe5bd3ecf",
    currency: "USD",
    priceField: "msrp_usd",
    market: "us",
    legacyColumns: false,
    hasSale: false,
    hasCollections: false,
  },
};

/** Resolve the `site` key from a request body; defaults to SinksDirect CA
 * so every pre-multi-site caller keeps its exact old behavior. Throws on
 * unknown keys — a typo must never silently write to the wrong store. */
export function resolveWixSite(siteKey: unknown): WixSite {
  const key = typeof siteKey === "string" && siteKey.trim() ? siteKey.trim() : "sinksdirect_ca";
  const site = WIX_SITES[key];
  if (!site) throw new Error(`Unknown Wix site "${key}". Valid: ${Object.keys(WIX_SITES).join(", ")}`);
  return site;
}
