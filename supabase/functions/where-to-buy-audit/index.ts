// "Where to Buy" audit for the Stylish brand sites (Stylish Canada / USA).
//
// mode "scan"  — reads every product of both sites through the Wix API,
//                parses the WHERE TO BUY and DOCUMENTS TO DOWNLOAD sections
//                into one row per link, cross-checks the ids in the URLs
//                against what the PIM knows, flags malformed URLs and the
//                retailers the product is listed on but never linked, and
//                replaces the site's rows (HTTP results younger than 7 days
//                carry over by URL).
// mode "check" — probes a paced batch of pending URLs over HTTP (one lane
//                per host, ~1.2 s between requests, ~35 s budget) and stores
//                ok / broken / redirected / blocked / unreachable. Called
//                every 15 min by cron and in a loop from the UI.
// mode "status"— counts of pending rows.
//
// Auth: `x-cron-secret` (cron) or a signed-in user's JWT. Deployed with
// --no-verify-jwt so the cron call (no JWT) reaches the handler.

import { resolveWixSite } from "../_shared/wixSites.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const WIX_API_KEY = Deno.env.get("WIX_API_KEY") ?? "";

const SITES = ["stylish_ca", "stylish_us"];
const CARRY_DAYS = 7;

// ---------------------------------------------------------------- retailers
interface Retailer { key: string; market: "ca" | "us" | null; label: string }
const RETAILERS: Array<{ host: RegExp } & Retailer> = [
  { host: /(^|\.)sinksdirect\.ca$/, key: "sinksdirect_ca", market: "ca", label: "SinksDirect.ca" },
  { host: /(^|\.)sinksdirectusa\.com$/, key: "sinksdirect_us", market: "us", label: "SinksDirect USA" },
  { host: /(^|\.)wayfair\.ca$/, key: "wayfair_ca", market: "ca", label: "Wayfair.ca" },
  { host: /(^|\.)wayfair\.com$/, key: "wayfair_us", market: "us", label: "Wayfair.com" },
  { host: /(^|\.)bestbuy\.ca$/, key: "bestbuy_ca", market: "ca", label: "BestBuy.ca" },
  { host: /(^|\.)homedepot\.ca$/, key: "homedepot_ca", market: "ca", label: "HomeDepot.ca" },
  { host: /(^|\.)homedepot\.com$/, key: "homedepot_us", market: "us", label: "HomeDepot.com" },
  { host: /(^|\.)walmart\.ca$/, key: "walmart_ca", market: "ca", label: "Walmart.ca" },
  { host: /(^|\.)walmart\.com$/, key: "walmart_us", market: "us", label: "Walmart.com" },
  { host: /(^|\.)amazon\.ca$/, key: "amazon_ca", market: "ca", label: "Amazon.ca" },
  { host: /(^|\.)amazon\.com$/, key: "amazon_us", market: "us", label: "Amazon.com" },
  { host: /(^|\.)bedbathandbeyond\.ca$/, key: "bbb_ca", market: "ca", label: "BedBathandBeyond.ca" },
  { host: /(^|\.)bedbathandbeyond\.com$/, key: "bbb_us", market: "us", label: "BedBathandBeyond.com" },
  { host: /(^|\.)rona\.ca$/, key: "rona", market: "ca", label: "Rona" },
  { host: /(^|\.)lowes\.ca$/, key: "lowes_ca", market: "ca", label: "Lowes.ca" },
  { host: /(^|\.)lowes\.com$/, key: "lowes_us", market: "us", label: "Lowes.com" },
  { host: /(^|\.)menards\.com$/, key: "menards", market: "us", label: "Menards" },
  { host: /(^|\.)kbauthority\.com$/, key: "kbauthority", market: "us", label: "KB Authority" },
  { host: /(^|\.)warehouse-usa\.com$/, key: "warehouse_usa", market: "us", label: "Warehouse USA" },
  { host: /(^|\.)overstock\.com$/, key: "overstock_us", market: "us", label: "Overstock.com" },
  { host: /(^|\.)overstock\.ca$/, key: "overstock_ca", market: "ca", label: "Overstock.ca" },
  { host: /(^|\.)cabinetdepotnewmarket\.com$/, key: "cabinet_depot", market: "ca", label: "Cabinet Depot" },
  { host: /(^|\.)buildwithrise\.com$/, key: "build_with_rise", market: "ca", label: "Build with Rise" },
  { host: /(^|\.)faucetline\.com$/, key: "faucetline", market: "us", label: "Faucetline" },
  { host: /(^|\.)ebay\.(ca|com)$/, key: "ebay", market: null, label: "eBay" },
  { host: /(^|\.)stylishkb\.com$/, key: "stylish_locator", market: null, label: "Store locator" },
  { host: /(^|\.)dropbox\.com$/, key: "dropbox", market: null, label: "Dropbox" },
  { host: /(^|\.)sharepoint\.com$/, key: "sharepoint", market: null, label: "SharePoint" },
  { host: /(^|\.)supabase\.co$/, key: "pim_storage", market: null, label: "PIM storage" },
];
const retailerFor = (host: string): Retailer =>
  RETAILERS.find((r) => r.host.test(host)) ?? { key: "other", market: null, label: host };

// The id each retailer puts in its product URL.
function extractId(retailer: string, url: string): string | null {
  const m = (re: RegExp) => url.match(re)?.[1] ?? null;
  switch (retailer) {
    case "wayfair_ca":
    case "wayfair_us":
      return (m(/-([a-z]{1,4}\d{4,10})(?:\.html|$|\?|#)/i) ?? m(/[?&](?:redir|piid)=([a-z]{1,4}\d{4,10})/i))?.toUpperCase() ?? null;
    case "homedepot_us": return m(/\/(\d{9})(?:[/?#]|$)/);
    case "homedepot_ca": return m(/\/(\d{10})(?:[/?#]|$)/);
    case "bestbuy_ca": return m(/\/(?:product|p)\/(?:[^/?#]+\/)?(\d{6,})(?:[/?#]|$)/);
    case "amazon_ca":
    case "amazon_us": return m(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.toUpperCase() ?? null;
    case "sinksdirect_ca":
    case "sinksdirect_us": return m(/\/product-page\/([^/?#]+)/i)?.toLowerCase() ?? null;
    case "walmart_ca": return m(/\/ip\/(?:[^/]+\/)?([A-Z0-9]{8,})/i);
    case "walmart_us": return m(/\/ip\/(?:[^/]+\/)?(\d{6,})/);
    case "lowes_us": return m(/\/pd\/[^/]+\/(\d+)/);
    case "rona": return m(/-(\d{8,9})(?:[/?#]|$)/);
    default: return null;
  }
}

// ---------------------------------------------------------------- html
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

interface Anchor { url: string; label: string; heading: string | null }
// Anchors in document order, each tagged with the closest preceding bold
// heading ("Online in Canada:", "In Stores in Canada:"…).
function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<strong[^>]*>([\s\S]*?)<\/strong>|<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let heading: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const h = text(m[1]);
      if (h && !/<a\b/i.test(m[1])) heading = h;
      continue;
    }
    out.push({ url: decode(m[2]).trim(), label: text(m[3]), heading });
  }
  return out;
}

// ---------------------------------------------------------------- rest
async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`REST ${r.status} ${path.slice(0, 80)}: ${(await r.text()).slice(0, 200)}`);
  if (init.method && init.method !== "GET" && (init.headers as Record<string, string> | undefined)?.Prefer !== "return=representation") return undefined as T;
  return (await r.json()) as T;
}
async function restAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await rest<T[]>(path, { headers: { Range: `${from}-${from + 999}`, Prefer: "count=none" } });
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const inList = (v: string[]) => `in.(${v.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(",")})`;

// ---------------------------------------------------------------- wix
interface WixProduct {
  id?: string; sku?: string; name?: string; visible?: boolean;
  additionalInfoSections?: Array<{ title?: string; description?: string }>;
  productPageUrl?: { base?: string; path?: string };
  variants?: Array<{ variant?: { sku?: string } }>;
}
async function wixCatalog(siteKey: string): Promise<WixProduct[]> {
  const site = resolveWixSite(siteKey);
  const products: WixProduct[] = [];
  for (let offset = 0; ;) {
    const resp = await fetch("https://www.wixapis.com/stores/v1/products/query", {
      method: "POST",
      headers: { Authorization: WIX_API_KEY, "wix-site-id": site.siteId, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { sort: '[{"numericId":"asc"}]', paging: { limit: 100, offset } }, includeHiddenProducts: true }),
    });
    if (!resp.ok) throw new Error(`Wix ${siteKey} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const batch: WixProduct[] = data.products ?? [];
    products.push(...batch);
    const total = data.totalResults ?? data.metadata?.count ?? products.length;
    offset += batch.length;
    if (!batch.length || offset >= total) break;
  }
  return products;
}
const skuOf = (p: WixProduct) => (p.sku?.trim() || p.variants?.[0]?.variant?.sku?.trim() || null);

// ---------------------------------------------------------------- scan
interface Row {
  site: string; sku: string; wix_product_id: string | null; section: string; market: string | null;
  retailer: string; label: string | null; url: string | null; host: string | null;
  retailer_id: string | null; expected_id: string | null; verdict: string;
  http_status: number | null; final_url: string | null; note: string | null;
  scanned_at: string; checked_at: string | null;
}

async function loadPim(skus: string[]) {
  const products = new Map<string, { wayfair_item_group_id: string | null; wayfair_usa_item_group_id: string | null }>();
  const hdUs = new Map<string, string>();
  const asin = new Map<string, string>();      // `${market}|${sku}` → asin
  const amazonListed = new Set<string>();      // `${market}|${sku}`
  const sinksSlug = new Map<string, string>(); // `${site}|${sku}` → slug
  const sinksLinked = new Set<string>();       // `${site}|${sku}`
  for (const part of chunk(skus, 150)) {
    const q = inList(part);
    (await rest<Array<{ sku: string; wayfair_item_group_id: string | null; wayfair_usa_item_group_id: string | null }>>(
      `products?select=sku,wayfair_item_group_id,wayfair_usa_item_group_id&sku=${q}`, { headers: { Prefer: "count=none" } },
    )).forEach((p) => products.set(p.sku, p));
    (await rest<Array<{ sku: string; alias: string }>>(`product_aliases?select=sku,alias&marketplace=eq.Home%20Depot%20US&sku=${q}`, { headers: { Prefer: "count=none" } }))
      .forEach((a) => hdUs.set(a.sku, a.alias));
    (await rest<Array<{ sku: string; marketplace: string; asin: string | null }>>(`amazon_links?select=sku,marketplace,asin&sku=${q}`, { headers: { Prefer: "count=none" } }))
      .forEach((a) => { amazonListed.add(`${a.marketplace}|${a.sku}`); if (a.asin) asin.set(`${a.marketplace}|${a.sku}`, a.asin.toUpperCase()); });
    (await rest<Array<{ sku: string; site: string }>>(`wix_links?select=sku,site&site=in.(sinksdirect_ca,sinksdirect_us)&sku=${q}`, { headers: { Prefer: "count=none" } }))
      .forEach((l) => sinksLinked.add(`${l.site}|${l.sku}`));
  }
  // SinksDirect slugs come from the live catalogs (productPageUrl.path).
  for (const s of ["sinksdirect_ca", "sinksdirect_us"]) {
    try {
      for (const p of await wixCatalog(s)) {
        const sku = skuOf(p);
        const slug = p.productPageUrl?.path?.match(/\/product-page\/([^/?#]+)/i)?.[1];
        if (sku && slug) sinksSlug.set(`${s}|${sku}`, slug.toLowerCase());
      }
    } catch (e) { console.warn(`[where-to-buy] ${s} catalog skipped:`, (e as Error).message); }
  }
  // Best Buy: latest offers snapshot (active offers + product id when the pull stores it).
  const bestbuy = new Map<string, { active: boolean; id: string | null }>();
  const walmartCa = new Set<string>();
  const latest = async (channel: string) => {
    const rows = await rest<Array<{ results: Array<Record<string, unknown>> | null }>>(`channel_health?select=results&channel=eq.${channel}&order=run_at.desc&limit=1`, { headers: { Prefer: "count=none" } });
    return rows[0]?.results ?? [];
  };
  for (const r of await latest("bestbuy")) {
    if (r.sku && r.active) bestbuy.set(String(r.sku), { active: true, id: r.bb_product_id ? String(r.bb_product_id) : null });
  }
  for (const r of await latest("walmart_ca")) if (r.sku) walmartCa.add(String(r.sku));
  return { products, hdUs, asin, amazonListed, sinksSlug, sinksLinked, bestbuy, walmartCa };
}

async function scanSite(siteKey: string, now: string) {
  const site = resolveWixSite(siteKey);
  const catalog = await wixCatalog(siteKey);
  const withSku = catalog.map((p) => ({ p, sku: skuOf(p) })).filter((x): x is { p: WixProduct; sku: string } => Boolean(x.sku));
  const pim = await loadPim(withSku.map((x) => x.sku));

  // HTTP results younger than CARRY_DAYS carry over by URL.
  const since = new Date(Date.now() - CARRY_DAYS * 86400e3).toISOString();
  const prior = new Map<string, { verdict: string; http_status: number | null; final_url: string | null; note: string | null; checked_at: string }>();
  for (const r of await restAll<{ url: string; verdict: string; http_status: number | null; final_url: string | null; note: string | null; checked_at: string }>(
    `where_to_buy_links?select=url,verdict,http_status,final_url,note,checked_at&site=eq.${siteKey}&checked_at=gte.${since}&url=not.is.null`,
  )) prior.set(r.url, r);

  const rows: Row[] = [];
  const counts = { products: withSku.length, links: 0, docs: 0, malformed: 0, id_mismatch: 0, missing: 0, dropbox: 0, no_section: 0 };
  for (const { p, sku } of withSku) {
    const sections = p.additionalInfoSections ?? [];
    const wtb = sections.find((s) => /where\s*to\s*buy/i.test(s.title ?? ""));
    const docs = sections.find((s) => /document/i.test(s.title ?? ""));
    const base = { site: siteKey, sku, wix_product_id: p.id ?? null, scanned_at: now };
    if (!wtb) {
      counts.no_section += 1;
      rows.push({ ...base, section: "where_to_buy", market: null, retailer: "none", label: null, url: null, host: null, retailer_id: null, expected_id: null, verdict: "no_section", http_status: null, final_url: null, note: "The page has no WHERE TO BUY section", checked_at: null });
    }
    const present = new Set<string>();
    const marketsSeen = new Set<string>();

    const pushLink = (section: string, a: Anchor) => {
      let host: string | null = null;
      let parsed: URL | null = null;
      try { parsed = new URL(a.url); host = parsed.hostname.toLowerCase(); } catch { parsed = null; }
      const ret = host ? retailerFor(host) : { key: "other", market: null, label: "" };
      const market = ret.market ?? (/canada/i.test(a.heading ?? "") ? "ca" : /usa|united states/i.test(a.heading ?? "") ? "us" : null);
      const rid = host ? extractId(ret.key, a.url) : null;
      let expected: string | null = null;
      switch (ret.key) {
        case "wayfair_ca": expected = pim.products.get(sku)?.wayfair_item_group_id ?? null; break;
        case "wayfair_us": expected = pim.products.get(sku)?.wayfair_usa_item_group_id ?? null; break;
        case "homedepot_us": expected = pim.hdUs.get(sku) ?? null; break;
        case "amazon_ca": expected = pim.asin.get(`ca|${sku}`) ?? null; break;
        case "amazon_us": expected = pim.asin.get(`us|${sku}`) ?? null; break;
        case "sinksdirect_ca": expected = pim.sinksSlug.get(`sinksdirect_ca|${sku}`) ?? null; break;
        case "sinksdirect_us": expected = pim.sinksSlug.get(`sinksdirect_us|${sku}`) ?? null; break;
        case "bestbuy_ca": expected = pim.bestbuy.get(sku)?.id ?? null; break;
      }
      let verdict = "unchecked";
      let note: string | null = null;
      if (!parsed || !/^https?:$/.test(parsed.protocol) || !host) { verdict = "malformed"; note = "Not a valid URL"; }
      else if (["wayfair_ca", "wayfair_us", "homedepot_us", "bestbuy_ca", "amazon_ca", "amazon_us", "sinksdirect_ca", "sinksdirect_us"].includes(ret.key) && !rid) { verdict = "malformed"; note = "No product id in the URL"; }
      else if (expected && rid && expected.toLowerCase() !== rid.toLowerCase()) {
        if (ret.key === "sinksdirect_ca" || ret.key === "sinksdirect_us") {
          // Old slugs usually redirect on Wix — the HTTP probe decides (it
          // compares the landing slug with the expected one).
          note = `Old address (current page is ${expected})`;
        } else if (ret.key === "wayfair_ca" || ret.key === "wayfair_us") {
          // The PIM holds the item GROUP id; variant links carry the child sku.
          note = `URL sku ${rid}, PIM group ${expected}`;
        } else { verdict = "id_mismatch"; note = `URL has ${rid}, PIM has ${expected}`; }
      }
      else if (/\s/.test(a.url)) note = "URL contains spaces";
      if (ret.key === "dropbox") counts.dropbox += 1;
      if (verdict === "malformed") counts.malformed += 1;
      if (verdict === "id_mismatch") counts.id_mismatch += 1;
      const carried = verdict === "unchecked" ? prior.get(a.url) : undefined;
      rows.push({
        ...base, section, market, retailer: ret.key, label: a.label || null, url: a.url, host,
        retailer_id: rid, expected_id: expected,
        verdict: carried ? carried.verdict : verdict,
        http_status: carried?.http_status ?? null, final_url: carried?.final_url ?? null,
        note: carried ? carried.note : note, checked_at: carried?.checked_at ?? null,
      });
      if (section === "where_to_buy") { present.add(ret.key); if (market) marketsSeen.add(market); counts.links += 1; }
      else counts.docs += 1;
    };
    if (wtb?.description) for (const a of anchors(wtb.description)) pushLink("where_to_buy", a);
    if (docs?.description) for (const a of anchors(docs.description)) pushLink("documents", a);

    // Retailers the PIM knows the product is on, absent from the section.
    // Only flagged when the page lists that market at all (some pages carry
    // one market only, on purpose).
    const expectations: Array<[string, string, boolean]> = [
      ["sinksdirect_ca", "ca", pim.sinksLinked.has(`sinksdirect_ca|${sku}`)],
      ["sinksdirect_us", "us", pim.sinksLinked.has(`sinksdirect_us|${sku}`)],
      ["wayfair_ca", "ca", Boolean(pim.products.get(sku)?.wayfair_item_group_id)],
      ["wayfair_us", "us", Boolean(pim.products.get(sku)?.wayfair_usa_item_group_id)],
      ["bestbuy_ca", "ca", pim.bestbuy.has(sku)],
      ["walmart_ca", "ca", pim.walmartCa.has(sku)],
      ["amazon_ca", "ca", pim.amazonListed.has(`ca|${sku}`)],
      ["amazon_us", "us", pim.amazonListed.has(`us|${sku}`)],
      ["homedepot_us", "us", pim.hdUs.has(sku)],
    ];
    for (const [key, market, listed] of expectations) {
      if (!listed || present.has(key) || !wtb) continue;
      if (!marketsSeen.has(market)) continue;
      counts.missing += 1;
      rows.push({ ...base, section: "where_to_buy", market, retailer: key, label: null, url: null, host: null, retailer_id: null, expected_id: null, verdict: "missing", http_status: null, final_url: null, note: "Listed there per the PIM, no link on the page", checked_at: null });
    }
  }

  // Replace the site's rows. A page sometimes repeats the very same link
  // (two anchors to one URL) — one row per (sku, section, retailer, url).
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const k = `${r.sku}|${r.section}|${r.retailer}|${r.url ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await rest(`where_to_buy_links?site=eq.${siteKey}`, { method: "DELETE" });
  for (const part of chunk(unique, 500)) await rest("where_to_buy_links", { method: "POST", body: JSON.stringify(part) });
  return { site: siteKey, label: site.label, rows: unique.length, duplicates: rows.length - unique.length, ...counts };
}

// ---------------------------------------------------------------- check
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const NOT_FOUND_RE = /<title[^>]*>[^<]*(?:not found|page not found|no longer available|isn.t available|couldn.t find|404)[^<]*<\/title>|"pageType"\s*:\s*"(?:404|notFound)"/i;
const BOT_RE = /<title[^>]*>[^<]*(?:pardon our interruption|access denied|are you a human|just a moment|attention required|robot check)[^<]*<\/title>/i;

// Document hosts (Dropbox, SharePoint, our own storage) answer with a
// status code alone — no body to read, so they run faster and in parallel.
const DOC_HOST = /dropbox\.com|sharepoint\.com|supabase\.co/;
const laneConfig = (host: string) =>
  /wayfair/.test(host) ? { pace: 3000, lanes: 1 } : DOC_HOST.test(host) ? { pace: 300, lanes: 3 } : { pace: 1200, lanes: 1 };

async function probe(url: string, expectedSlug: string | null = null): Promise<{ verdict: string; http_status: number | null; final_url: string | null; note: string | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url.replace(/ /g, "%20"), { headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: ctrl.signal });
    const status = r.status;
    const finalUrl = r.url || url;
    let body = "";
    if (DOC_HOST.test(new URL(finalUrl).hostname)) { try { await r.body?.cancel(); } catch { /* ignore */ } }
    else { try { body = (await r.text()).slice(0, 200000); } catch { body = ""; } }
    if (status === 404 || status === 410) return { verdict: "broken", http_status: status, final_url: finalUrl, note: `HTTP ${status}` };
    if (status === 403 || status === 429 || status === 401) return { verdict: "blocked", http_status: status, final_url: finalUrl, note: "The site refuses automated checks" };
    // Amazon (and others) answer 500/503 to datacenter traffic — a robot
    // block, not a broken page.
    if (status >= 500) return { verdict: "blocked", http_status: status, final_url: finalUrl, note: `The site refuses automated checks (HTTP ${status})` };
    if (BOT_RE.test(body)) return { verdict: "blocked", http_status: status, final_url: finalUrl, note: "Bot challenge page" };
    if (NOT_FOUND_RE.test(body)) return { verdict: "broken", http_status: status, final_url: finalUrl, note: "The page says the product was not found" };
    try {
      const a = new URL(url); const b = new URL(finalUrl);
      const rootHost = (h: string) => h.replace(/^www\./, "");
      if (expectedSlug) {
        const landed = b.pathname.match(/\/product-page\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? null;
        if (landed && landed !== expectedSlug.toLowerCase()) return { verdict: "id_mismatch", http_status: status, final_url: finalUrl, note: `Opens ${landed}, the product's page is ${expectedSlug}` };
      }
      if (rootHost(a.hostname) !== rootHost(b.hostname)) return { verdict: "redirected", http_status: status, final_url: finalUrl, note: `Redirected to ${b.hostname}` };
      if (/password|login|signin/i.test(b.pathname)) return { verdict: "redirected", http_status: status, final_url: finalUrl, note: "Redirected to a login / password page" };
      if ((b.pathname === "/" || b.pathname === "") && a.pathname.length > 1) return { verdict: "redirected", http_status: status, final_url: finalUrl, note: "Redirected to the home page" };
    } catch { /* keep ok */ }
    if (status >= 200 && status < 400) return { verdict: "ok", http_status: status, final_url: finalUrl, note: null };
    return { verdict: "unreachable", http_status: status, final_url: finalUrl, note: `HTTP ${status}` };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "No answer in 12 s" : /error sending request|connection|reset|refused/i.test((e as Error).message) ? "Connection dropped by the site" : (e as Error).message.slice(0, 120);
    return { verdict: "unreachable", http_status: null, final_url: null, note: msg };
  } finally { clearTimeout(t); }
}

async function check(budgetMs = 35000, limit = 400) {
  const started = Date.now();
  const since = new Date(Date.now() - CARRY_DAYS * 86400e3).toISOString();
  // Pending: never probed, or probed more than CARRY_DAYS ago.
  const pending = await rest<Array<{ id: string; url: string; host: string; retailer: string; expected_id: string | null }>>(
    `where_to_buy_links?select=id,url,host,retailer,expected_id&url=not.is.null&verdict=not.in.(malformed,id_mismatch,missing)&or=(checked_at.is.null,checked_at.lt.${since})&order=checked_at.asc.nullsfirst&limit=${limit}`,
    { headers: { Prefer: "count=none" } },
  );
  const byHost = new Map<string, typeof pending>();
  for (const r of pending) { const h = (r.host ?? "").replace(/^www\./, ""); if (!byHost.has(h)) byHost.set(h, []); byHost.get(h)!.push(r); }
  const results: Array<{ id: string } & Awaited<ReturnType<typeof probe>>> = [];
  const hostStats: Record<string, { checked: number; blocked: number }> = {};
  await Promise.all([...byHost.entries()].map(async ([host, rows]) => {
    const stat = { checked: 0, blocked: 0 };
    hostStats[host] = stat;
    let blockedInARow = 0;
    // Wayfair rate-limits hard: 3 s between hits; document hosts run 3
    // lanes at 300 ms; everyone else one lane at 1.2 s.
    const { pace, lanes } = laneConfig(host);
    let next = 0;
    const lane = async () => {
      while (next < rows.length && Date.now() - started <= budgetMs) {
        const r = rows[next++];
        let res: Awaited<ReturnType<typeof probe>>;
        if (blockedInARow >= 3) {
          res = { verdict: "blocked", http_status: null, final_url: null, note: "The site refuses automated checks" };
        } else {
          res = await probe(r.url, /^sinksdirect_/.test(r.retailer) ? r.expected_id : null);
          if (res.verdict === "blocked") blockedInARow += 1; else blockedInARow = 0;
          await new Promise((ok) => setTimeout(ok, pace));
        }
        stat.checked += 1;
        if (res.verdict === "blocked") stat.blocked += 1;
        results.push({ id: r.id, ...res });
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
  }));
  const now = new Date().toISOString();
  // One PATCH per distinct outcome (not per row): the gateway drops the
  // connection when 600 sequential updates follow a 45 s probe run.
  // final_url is kept only where it matters (redirects).
  const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
  for (const r of results) {
    const keepFinal = r.verdict === "redirected";
    const patch = { verdict: r.verdict, http_status: r.http_status, final_url: keepFinal ? r.final_url : null, note: r.note, checked_at: now };
    const key = JSON.stringify(patch);
    if (!groups.has(key)) groups.set(key, { patch, ids: [] });
    groups.get(key)!.ids.push(r.id);
  }
  for (const g of groups.values()) {
    for (const ids of chunk(g.ids, 200)) {
      await rest(`where_to_buy_links?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify(g.patch) });
    }
  }
  const byVerdict: Record<string, number> = {};
  for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  return { checked: results.length, remaining: Math.max(0, pending.length - results.length), morePending: pending.length >= limit || pending.length > results.length, byVerdict, hosts: hostStats, ms: Date.now() - started };
}

async function status() {
  const since = new Date(Date.now() - CARRY_DAYS * 86400e3).toISOString();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/where_to_buy_links?select=id&url=not.is.null&verdict=not.in.(malformed,id_mismatch,missing)&or=(checked_at.is.null,checked_at.lt.${since})`, {
    method: "HEAD", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact" },
  });
  const pending = Number(r.headers.get("content-range")?.split("/")[1] ?? 0);
  return { pending };
}

// ---------------------------------------------------------------- auth
async function authorized(req: Request): Promise<boolean> {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) return true;
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: auth } });
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    if (!(await authorized(req))) return json({ error: "Unauthorized" }, 401);
    if (!WIX_API_KEY) return json({ error: "Missing WIX_API_KEY secret." }, 500);
    const body = await req.json().catch(() => ({}));
    const mode = body.mode ?? "status";
    if (mode === "scan") {
      const now = new Date().toISOString();
      const sites = Array.isArray(body.sites) && body.sites.length ? body.sites.filter((s: string) => SITES.includes(s)) : SITES;
      const out = [];
      for (const s of sites) out.push(await scanSite(s, now));
      return json({ ok: true, scanned_at: now, sites: out });
    }
    if (mode === "check") return json({ ok: true, ...(await check(body.budgetMs ?? 35000, body.limit ?? 400)) });
    return json({ ok: true, ...(await status()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[where-to-buy-audit] FAILED:", message);
    return json({ error: message }, 500);
  }
});
