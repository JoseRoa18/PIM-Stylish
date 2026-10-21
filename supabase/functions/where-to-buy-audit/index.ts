// "Where to Buy" audit for the Stylish brand sites (Stylish Canada / USA).
//
// mode "scan"  — reads every product of both sites through the Wix API and
//                writes one row per store link. Since 2026-10-19 the PIM owns
//                the links (product_where_to_buy, one list per product that
//                builds both pages' section — _shared/whereToBuy.js): a PIM
//                product's rows come from that list and its live WHERE TO
//                BUY section is compared with it (a hand edit in Wix shows up
//                in `differs`); a page whose SKU the PIM lacks is left out
//                (only PIM products are audited). Flags the portals a page lacks (the ones most products
//                link), replaces the site's rows (the checker's state carries
//                over by URL) and keeps standard portals + differences in
//                app_settings.where_to_buy_scan. The store locator, document
//                links and unknown sites are not checked (user, 2026-10-19).
// mode "sync"  — { skus }: a product's links were saved in the PIM; rebuilds
//                its rows on both sites and checks the new addresses at once.
// mode "check" — opens a batch of due links (~110 s budget) and records the
//                verdict. Each retailer has a ROUTE: the server's own probe
//                ("direct") where the site lets it in; otherwise Bright
//                Data's Web Unlocker (primary, pay per success) and
//                ScraperAPI (backup, free plan) — tested store by store on
//                2026-10-19. Menards only opens through Bright Data's ASYNC
//                mode from a US exit (minutes per page), so its links are
//                submitted as jobs and collected on a later pass. Rhythm
//                (user, 2026-10-20): an OK link every 3 days, a broken one
//                every 2 days, a link without an answer after a few hours
//                (`next_check_at`). Called by cron every 10 minutes (each call chains
//                the next batch until nothing is due) and from the UI;
//                `skus: [...]` re-checks those products' links now.
// mode "p2s"   — applies a Price2Spy matrix report (parsed in the browser:
//                one row per SKU × site with the URL Price2Spy monitors and
//                its status). Price2Spy visits the retailers with residential
//                IPs, so it settles the links the server cannot open: a price
//                seen or a page without price → ok, an inactive URL → broken.
//                Only rows still pending, or last checked before the report
//                date, are touched.
// mode "p2s-file" — same as "p2s" but receives the xlsx itself (base64) and
//                parses it here: the Gmail Apps Script posts the daily
//                Price2Spy attachments this way, authenticated with the
//                P2S_INBOUND_SECRET header (x-p2s-secret).
// mode "suggest" — the right link, suggested (user, 2026-10-20): for a link
//                that opens another option or product, a broken link, or a
//                store a product has no link to yet, looks for the product's
//                own page at that store (another link that opens it, an
//                option a page lists, an id the PIM keeps) and opens each
//                candidate before it is shown (where_to_buy_suggestions).
//                Cron every 10 minutes; the candidates are looked for hourly.
// mode "publish" — writes the next products of the publish queue to the
//                Stylish pages (cron every 5 minutes; the check calls also
//                drain it when they have time left).
// mode "status"— count of rows due for a probe.
//
// Verdicts (user rules 2026-09-15 and 2026-10-19 — the list says OK or Broken):
//   ok       the link opens and shows the product (through an unlocker: the
//            page names Stylish / Azuni or the SKU — title, product data or text)
//   broken   there is a link but it does not work: 404 / 410, a "not found"
//            page, a redirect to a login / home page, or an invalid address.
//            Weaker evidence — Menards' unlocker giving up, a page that opens
//            without the product — needs repeated answers (SOFT_RULE: two
//            days; Menards four tries 6 h apart).
//   missing  the page has no link to a portal that most products of the
//            site (same market) do link — shown as a KPI of links to add
//   pending  not verified yet (never checked, or no service answered yet)
//   manual   a site no service can open (Faucetline, the Loblaw banners):
//            checked by hand
// The `note` column carries the reason, `checked_via` who answered.
//
// The page a check opens is also READ (user, 2026-10-20 — _shared/pageProduct.js):
// the model it shows (`page_model`, `sku_check`: match / variant / other /
// unknown) and its price (`price`, `was_price`, `currency`, `in_stock`,
// `read_at`) for Price Alignment. A page on ANOTHER PIM product is a soft
// sign: twice in a row (two days apart) and the link is Broken — "Opens
// another product".
//
// Auth: `x-cron-secret` (cron) or a signed-in user's JWT. Deployed with
// --no-verify-jwt so the cron call (no JWT) reaches the handler.

import { resolveWixSite } from "../_shared/wixSites.ts";
import { WTB_RETAILERS, wtbRetailer, cleanWtbUrl, linksToShow, isHiddenLink, withWhereToBuySection } from "../_shared/whereToBuy.js";
import { readProductPage, menardsRead, lowesRecordRead, pimCatalog, skuCheck, SURE_READERS } from "../_shared/pageProduct.js";
import { normSku } from "../_shared/pageReaders/common.js";
import { PAGE_STORES } from "../_shared/pageStores.js";
import { etToday, periodOfDay, prevPeriod, promoWindow, shiftDay, PROMO_DATE_COLUMNS, type Market } from "../_shared/promoCalendar.ts";

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
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const P2S_INBOUND_SECRET = Deno.env.get("P2S_INBOUND_SECRET") ?? "";
const BRIGHTDATA_API_TOKEN = Deno.env.get("BRIGHTDATA_API_TOKEN") ?? "";
const BRIGHTDATA_ZONE = Deno.env.get("BRIGHTDATA_ZONE") ?? "web_unlocker1";
const SCRAPERAPI_KEY = Deno.env.get("SCRAPERAPI_KEY") ?? "";

const SITES = ["stylish_ca", "stylish_us"];
const KEEP_DAYS = 7;        // a scan carries ok / broken results younger than a week
const OK_HOURS = 72;        // an OK link is re-checked every 3 days (user, 2026-10-20: ~55 USD/month)
const BROKEN_HOURS = 48;    // a broken one every 2 days — also the gap between two soft signals
const RETRY_HOURS = 3;      // no answer: again after 3 h, 6 h, … at most a day
const JOB_POLL_MIN = 10;    // Menards async job: first look after 10 minutes
const JOB_GIVEUP_HOURS = 6; // … still running after 6 h counts as a soft signal
const LEASE_MIN = 15;       // a batch claims its links for 15 min (no double work)
const BATCH_MS = 110000;    // one check call (the runtime cuts at ~150 s)
const START_MS = 55000;     // no link starts after this point of the call
const MAX_CHAIN = 4;        // cron chain (every 10 min): at most 4 more batches per call
const STANDARD_SHARE = 0.6; // a portal is "standard" when 60% of the pages link it
const NEVER = "2999-01-01T00:00:00.000Z"; // scan-time verdicts are never probed

// ---------------------------------------------------------------- retailers
// The stores the PIM keeps — one registry for the product page, this audit
// and the push to Wix (supabase/functions/_shared/whereToBuy.js). The store
// locator, document links and unknown sites are not checked (user, 2026-10-19).
const retailerFor = (host: string): { key: string; market: string; label: string } | null =>
  WTB_RETAILERS.find((r: { host: RegExp }) => r.host.test(host)) ?? null;

// How each retailer's links are opened, in order — measured on 2026-10-19
// with the same links through every service:
//   Bright Data opens Wayfair, Home Depot CA / USA, Best Buy, Amazon.ca and
//   Rona (ScraperAPI never does). ScraperAPI opens BB&B and Overstock
//   (Akamai turns Bright Data away, 1-2 of 5) and eBay. Amazon lets the
//   server in, but without its prices (see below). Menards and Lowe's go
//   through Bright Data's ready-made scrapers ("scraper", see SCRAPERS):
//   Lowe's opened 7 of 8 links on 2026-10-19 and put a captcha in front of
//   the Web Unlocker the next day.
// Anything not listed: the server's probe, then one Bright Data try.
type Method = "direct" | "brightdata" | "scraperapi" | "scraper";
const ROUTES: Record<string, Method[]> = {
  wayfair_us: ["brightdata", "scraperapi"],
  wayfair_ca: ["brightdata", "scraperapi"],
  homedepot_ca: ["brightdata", "scraperapi"],
  homedepot_us: ["brightdata", "scraperapi"],
  bestbuy_ca: ["brightdata", "scraperapi"],
  lowes_us: ["scraper"],
  rona: ["brightdata"],
  menards: ["scraper"],
  bbb_us: ["scraperapi", "brightdata"],
  overstock_us: ["scraperapi", "brightdata"],
  ebay: ["scraperapi", "brightdata"],
  // Amazon hides the price from the server's own probe (Amazon.ca: a US
  // address, "Deliver to United States", no buy box; Amazon.com: the coupon
  // but no price — 2026-10-20), so its pages go through Bright Data first
  // (it exits in the store's country) and the probe only settles the link
  // when Bright Data does not answer (~10 USD a month for both stores).
  amazon_ca: ["brightdata", "direct", "scraperapi"],
  amazon_us: ["brightdata", "direct", "scraperapi"],
  // Aquarina (a dealer watched for price, pageStores.js) answers the server
  // with Cloudflare's "Attention Required" (403); Bright Data opens it.
  aquarina: ["brightdata", "scraperapi"],
};
const routeFor = (retailer: string, host: string): Method[] =>
  DOC_HOST.test(host) ? ["direct"] : ROUTES[retailer] ?? ["direct", "brightdata"];
// Sites neither service opens (2026-10-19): checked by hand.
const MANUAL_HOST = /(^|\.)(faucetline\.com|loblaws\.ca|fortinos\.ca|provigo\.ca)$/;

// Wayfair addresses need the product sku ("…-tkjs1238.html"); a cut link
// without it lands on a 404 (verified 2026-09-15). Wayfair blocks robots, so
// this is the one shape rule kept — the rest is decided by opening the link.
const WAYFAIR_SKU_RE = /-[a-z]{1,4}\d{4,10}(?:\.html|$|\?|#)|[?&](?:redir|piid)=[a-z]{1,4}\d{4,10}/i;

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
  if (init.method && init.method !== "GET") return undefined as T;
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
// What the page last said about its product (see pageProduct.js).
interface Reading {
  page_model: string | null; page_item_id: string | null; sku_check: string | null; page_note: string | null;
  price: number | null; was_price: number | null; currency: string | null; in_stock: boolean | null; read_at: string | null;
  page_options: OptionLink[] | null;
}
const NO_READING: Reading = { page_model: null, page_item_id: null, sku_check: null, page_note: null, price: null, was_price: null, currency: null, in_stock: null, read_at: null, page_options: null };
interface Row extends Reading {
  site: string; sku: string; wix_product_id: string | null; section: string; market: string | null;
  retailer: string; label: string | null; url: string | null; host: string | null;
  retailer_id: string | null; expected_id: string | null; verdict: string;
  http_status: number | null; final_url: string | null; note: string | null;
  scanned_at: string; checked_at: string | null;
  next_check_at: string | null; checked_via: string | null; fail_count: number; signal_count: number; signal_at: string | null;
  job_id: string | null; job_at: string | null;
}
// The checker's state on a link, carried over by URL when a scan rebuilds the rows.
type LinkState = Pick<Row, "verdict" | "http_status" | "final_url" | "note" | "checked_at" | "next_check_at" | "checked_via" | "fail_count" | "signal_count" | "signal_at" | "job_id" | "job_at" | keyof Reading>;
const STATE_COLUMNS = "url,verdict,http_status,final_url,note,checked_at,next_check_at,checked_via,fail_count,signal_count,signal_at,job_id,job_at,page_model,page_item_id,sku_check,page_note,price,was_price,currency,in_stock,read_at,page_options";
type Base = { site: string; sku: string; wix_product_id: string | null; scanned_at: string };
type Link = { retailer: string; url: string };
interface PimLinks { skus: Set<string>; brands: Map<string, string>; links: Map<string, Link[]> }

// The PIM's own list (product_where_to_buy) — the source of every Stylish
// page's WHERE TO BUY section since 2026-10-19.
async function loadPimLinks(skus?: string[]): Promise<PimLinks> {
  const only = skus?.length ? `&sku=${inList(skus)}` : "";
  const products = await restAll<{ sku: string; brand: string | null }>(`products?select=sku,brand${only}`);
  const links = new Map<string, Link[]>();
  for (const r of await restAll<{ sku: string } & Link>(`product_where_to_buy?select=sku,retailer,url${only}`)) {
    if (!links.has(r.sku)) links.set(r.sku, []);
    links.get(r.sku)!.push({ retailer: r.retailer, url: r.url });
  }
  return { skus: new Set(products.map((p) => p.sku)), brands: new Map(products.map((p) => [p.sku, p.brand ?? ""])), links };
}

// The checker's state of the links — from either site, as both pages carry
// the same address: ok / broken verdicts it reached in the last KEEP_DAYS,
// and every pending link's retries, soft signals and Menards job. Kept by
// SKU + address (whether the page shows THIS product is the SKU's own
// answer) and by address alone for a SKU that just got an address another
// product already has.
interface Prior { bySkuUrl: Map<string, LinkState>; byUrl: Map<string, LinkState> }
async function priorState(skus?: string[]): Promise<Prior> {
  const since = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString();
  const prior: Prior = { bySkuUrl: new Map(), byUrl: new Map() };
  const filter = skus?.length ? `&sku=${inList(skus)}` : "";
  // A verdict beats "pending"; between two of a kind, the newer answer.
  const better = (prev: LinkState | undefined, r: LinkState) => !prev || (prev.verdict === "pending" && r.verdict !== "pending")
    || ((prev.verdict === "pending") === (r.verdict === "pending") && (r.checked_at ?? "") > (prev.checked_at ?? ""));
  for (const r of await restAll<{ url: string; sku: string } & LinkState>(
    `where_to_buy_links?select=sku,${STATE_COLUMNS}&url=not.is.null${filter}&or=(verdict.eq.pending,and(verdict.in.(ok,broken),checked_via.not.is.null,checked_at.gte.${since}))`,
  )) {
    const k = `${r.sku}|${r.url}`;
    if (better(prior.bySkuUrl.get(k), r)) prior.bySkuUrl.set(k, r);
    if (better(prior.byUrl.get(r.url), r)) prior.byUrl.set(r.url, r);
  }
  return prior;
}

// The state a SKU's link carries: its own, else the address's — only what
// holds for the address itself (it opens, or it is dead); what the page said
// about ITS product (the reading, the SKU check, its signs) was another SKU's,
// so the link is read for this one at once. A Broken that came from such a
// sign is checked again.
function carriedState(prior: Prior, sku: string, url: string): LinkState | undefined {
  const own = prior.bySkuUrl.get(`${sku}|${url}`);
  if (own) return own;
  const shared = prior.byUrl.get(url);
  if (!shared) return undefined;
  const fresh = { ...shared, ...NO_READING, signal_count: 0, signal_at: null, next_check_at: null };
  if (shared.verdict === "broken" && /^Opens (another product|a page without the product)/.test(shared.note ?? "")) {
    return { ...fresh, verdict: "pending", note: null, checked_at: null, checked_via: null, fail_count: 0 };
  }
  return fresh;
}

// One row per store link of a page. Decided without opening it: an address
// that is not a URL, or a Wayfair link cut before the sku, cannot open; a
// site no service opens is checked by hand. Everything else starts pending
// (or carries the checker's state) and the checker decides.
function linkRows(base: Base, links: Link[], prior: Prior): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const r = wtbRetailer(l.retailer);
    const key = `${l.retailer}|${l.url}`;
    if (!r || seen.has(key)) continue;
    seen.add(key);
    let host: string | null = null;
    let parsed: URL | null = null;
    try { parsed = new URL(l.url); host = parsed.hostname.toLowerCase(); } catch { parsed = null; }
    let verdict = "pending";
    let note: string | null = null;
    if (!parsed || !/^https?:$/.test(parsed.protocol) || !host) { verdict = "broken"; note = "Not a valid web address"; }
    else if ((r.key === "wayfair_ca" || r.key === "wayfair_us") && !WAYFAIR_SKU_RE.test(l.url)) { verdict = "broken"; note = "Cut address: Wayfair links need the product sku at the end"; }
    else if (MANUAL_HOST.test(host)) { verdict = "manual"; note = "Check by hand: this site turns every automatic check away"; }
    const carried = verdict === "pending" ? carriedState(prior, base.sku, l.url) : undefined;
    const fresh: LinkState = {
      verdict, http_status: null, final_url: null, note, checked_at: null,
      next_check_at: verdict === "pending" ? null : NEVER, checked_via: null,
      fail_count: 0, signal_count: 0, signal_at: null, job_id: null, job_at: null, ...NO_READING,
    };
    const { url: _u, sku: _s, ...state } = (carried ?? fresh) as LinkState & { url?: string; sku?: string };
    rows.push({ ...base, section: "where_to_buy", market: r.market, retailer: r.key, label: r.label, url: l.url, host, retailer_id: null, expected_id: null, ...state });
  }
  return rows;
}

// Links to add: the site's STANDARD portals are the retailers linked by at
// least STANDARD_SHARE of the products that have links (2026-09-15:
// SinksDirect, Amazon, Wayfair, Home Depot CA, Rona, Best Buy, Walmart CA on
// both sites). A product without one of them (for a country it lists) gets a
// "missing" row; a product with no link at all gets one per standard portal.
function missingRows(base: Base, links: Link[], standard: string[]): Row[] {
  const present = new Set(links.map((l) => l.retailer));
  const markets = new Set(links.map((l) => wtbRetailer(l.retailer)?.market).filter(Boolean));
  const rows: Row[] = [];
  for (const k of standard) {
    if (present.has(k)) continue;
    const market = wtbRetailer(k)?.market ?? null;
    if (links.length && market && !markets.has(market)) continue;
    rows.push({
      ...base, section: "where_to_buy", market, retailer: k, label: null, url: null, host: null, retailer_id: null, expected_id: null,
      verdict: "missing", http_status: null, final_url: null, note: links.length ? "No link to this store yet (most products have one)" : "No Where to Buy links yet", checked_at: null,
      next_check_at: null, checked_via: null, fail_count: 0, signal_count: 0, signal_at: null, job_id: null, job_at: null, ...NO_READING,
    });
  }
  return rows;
}

function dedupeRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.sku}|${r.section}|${r.retailer}|${r.url ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// The store links of a live WHERE TO BUY section.
function liveLinks(html: string): Link[] {
  const out: Link[] = [];
  for (const a of anchors(html)) {
    let host = "";
    try { host = new URL(a.url).hostname.toLowerCase(); } catch { continue; }
    const r = retailerFor(host);
    if (r) out.push({ retailer: r.key, url: a.url });
  }
  return out;
}
const linkSet = (links: Link[]) => links.map((l) => `${l.retailer}|${cleanWtbUrl(l.url)}`).sort().join("\n");

async function scanSite(siteKey: string, now: string, pim: PimLinks) {
  const site = resolveWixSite(siteKey);
  const catalog = await wixCatalog(siteKey);
  // Open Box listings (SKUs like A-802B-B-OB-A, or "Open Box" in the name)
  // are one-off clearance pages — never audited (user rule, 2026-09-15).
  const isOpenBox = (sku: string, name: string) => /-OB(-|$)/i.test(sku) || /open\s*box/i.test(name);
  const withSku = catalog
    .map((p) => ({ p, sku: skuOf(p) }))
    .filter((x): x is { p: WixProduct; sku: string } => Boolean(x.sku) && !isOpenBox(x.sku!, x.p.name ?? ""));
  const prior = await priorState();

  // A SKU listed twice on Wix (B-122NG) counts once — its visible listing.
  const bestBySku = new Map<string, { p: WixProduct; sku: string }>();
  for (const x of withSku) {
    const prev = bestBySku.get(x.sku);
    if (!prev || (prev.p.visible === false && x.p.visible !== false)) bestBySku.set(x.sku, x);
  }

  // The PIM must know each page to write it (wix_links). A PIM product found
  // on the site without that link gets it by its SKU (user, 2026-10-20: 52
  // Stylish USA pages had none and kept their hand-made section) — never an
  // Azuni product, and never a Wix product already linked to another SKU.
  const known = await restAll<{ sku: string; wix_product_id: string }>(`wix_links?select=sku,wix_product_id&site=eq.${siteKey}`);
  const linkedSku = new Set(known.map((k) => k.sku));
  const linkedId = new Set(known.map((k) => k.wix_product_id));
  const newLinks = [...bestBySku.values()]
    .filter(({ p, sku }) => p.id && pim.skus.has(sku) && !linkedSku.has(sku) && !linkedId.has(p.id) && !/azuni/i.test(pim.brands.get(sku) ?? ""))
    .map(({ p, sku }) => ({ site: siteKey, sku, wix_product_id: p.id! }));
  for (const part of chunk(newLinks, 200)) await rest("wix_links", { method: "POST", body: JSON.stringify(part) });

  const rows: Row[] = [];
  const counts = { products: 0, links: 0, broken: 0, missing: 0, notInPim: 0, newlyLinked: newLinks.map((l) => l.sku), differsFromPim: [] as string[], standardPortals: [] as string[] };
  const perProduct: Array<{ base: Base; links: Link[] }> = [];
  for (const { p, sku } of bestBySku.values()) {
    // Only the PIM's products are audited (user, 2026-10-19): a Wix page
    // whose SKU the PIM does not have (spare parts like RSH-K107B, old
    // listings) is left out.
    if (!pim.skus.has(sku)) { counts.notInPim += 1; continue; }
    counts.products += 1;
    const wtb = (p.additionalInfoSections ?? []).find((s) => /where\s*to\s*buy/i.test(s.title ?? ""));
    const live = liveLinks(wtb?.description ?? "");
    const base: Base = { site: siteKey, sku, wix_product_id: p.id ?? null, scanned_at: now };
    // Checked from the PIM's list; the live section is compared with it
    // (a hand edit in Wix shows up as a difference).
    const links = pim.links.get(sku) ?? [];
    const lr = linkRows(base, links, prior);
    // What the page should show: the list without its broken and wrong-product links.
    const shown = lr.filter((r) => !isHiddenLink(r.verdict, r.sku_check)).map((r) => ({ retailer: r.retailer, url: r.url as string }));
    if (links.length && linkSet(live) !== linkSet(shown)) counts.differsFromPim.push(sku);
    counts.links += lr.length;
    counts.broken += lr.filter((r) => r.verdict === "broken").length;
    rows.push(...lr);
    perProduct.push({ base, links });
  }

  const withLinks = perProduct.filter((x) => x.links.length);
  const tally = new Map<string, number>();
  for (const x of withLinks) for (const k of new Set(x.links.map((l) => l.retailer))) tally.set(k, (tally.get(k) ?? 0) + 1);
  const standard = [...tally.entries()].filter(([, n]) => n >= withLinks.length * STANDARD_SHARE).map(([k]) => k);
  counts.standardPortals = standard;
  for (const x of perProduct) {
    const mr = missingRows(x.base, x.links, standard);
    counts.missing += mr.length;
    rows.push(...mr);
  }

  // One row per (sku, section, retailer, url) — the table's unique key.
  const unique = dedupeRows(rows);
  await rest(`where_to_buy_links?site=eq.${siteKey}`, { method: "DELETE" });
  for (const part of chunk(unique, 500)) await rest("where_to_buy_links", { method: "POST", body: JSON.stringify(part) });
  return { site: siteKey, label: site.label, rows: unique.length, ...counts };
}

// What the last scan learned, kept for the panel and for "sync": each site's
// standard portals and the products whose live section differs from the PIM.
const SCAN_KEY = "where_to_buy_scan";
type ScanState = { scanned_at?: string; standard?: Record<string, string[]>; differs?: Record<string, string[]> };
async function readScanState(): Promise<ScanState> {
  const r = await rest<Array<{ value: ScanState }>>(`app_settings?select=value&key=eq.${SCAN_KEY}`);
  return r[0]?.value ?? {};
}
async function writeScanState(value: ScanState) {
  await rest("app_settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: SCAN_KEY, value, updated_at: new Date().toISOString() }),
  });
}

// After a product's links are saved (and pushed to Wix) in the PIM: rebuild
// its rows on both sites from the new list — keeping the checker's state of
// the addresses that did not change; the new ones are due at once.
async function syncSkus(skus: string[]) {
  const now = new Date().toISOString();
  const pim = await loadPimLinks(skus);
  const state = await readScanState();
  const out: Array<{ site: string; sku: string; links: number; missing: number }> = [];
  for (const siteKey of SITES) {
    const onSite = await rest<Array<{ sku: string; wix_product_id: string }>>(`wix_links?select=sku,wix_product_id&site=eq.${siteKey}&sku=${inList(skus)}`);
    if (!onSite.length) continue;
    const prior = await priorState(onSite.map((x) => x.sku));
    const rows: Row[] = [];
    for (const w of onSite) {
      const base: Base = { site: siteKey, sku: w.sku, wix_product_id: w.wix_product_id, scanned_at: now };
      const links = pim.links.get(w.sku) ?? [];
      const lr = linkRows(base, links, prior);
      const mr = missingRows(base, links, state.standard?.[siteKey] ?? []);
      rows.push(...lr, ...mr);
      out.push({ site: siteKey, sku: w.sku, links: lr.length, missing: mr.length });
    }
    await rest(`where_to_buy_links?site=eq.${siteKey}&sku=${inList(onSite.map((x) => x.sku))}`, { method: "DELETE" });
    for (const part of chunk(dedupeRows(rows), 500)) await rest("where_to_buy_links", { method: "POST", body: JSON.stringify(part) });
  }
  // The pages were just pushed from the PIM: they no longer differ.
  if (state.differs) {
    const differs = Object.fromEntries(Object.entries(state.differs).map(([k, v]) => [k, v.filter((s) => !skus.includes(s))]));
    await writeScanState({ ...state, differs });
  }
  // A suggestion whose address is now the product's link was used.
  await settleSuggestions(skus, pim);
  return out;
}

// ---------------------------------------------------------------- check
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
// A browser's request headers: the Shopify dealers (Cabinet Depot, Build with
// Rise) answer 429 "Too many requests" to a request without the sec-ch-ua /
// Sec-Fetch-* headers (2026-10-20), which sent them to Bright Data.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
const NOT_FOUND_RE = /<title[^>]*>[^<]*(?:not found|page not found|no longer available|isn.t available|couldn.t find|404)[^<]*<\/title>|"pageType"\s*:\s*"(?:404|notFound)"/i;
const BOT_RE = /<title[^>]*>[^<]*(?:pardon our interruption|access denied|are you a human|robot or human|verify your identity|just a moment|attention required|robot check)[^<]*<\/title>/i;
// Amazon's captcha page is titled just "Amazon.ca" (seen 2026-10-19).
const BOT_BODY_RE = /validateCaptcha|Enter the characters you see below/i;

// Document hosts (Dropbox, SharePoint, our own storage) answer with a
// status code alone — no body to read, so they run faster and in parallel.
const DOC_HOST = /dropbox\.com|sharepoint\.com|supabase\.co/;
const laneConfig = (host: string) =>
  /wayfair/.test(host) ? { pace: 3000, lanes: 1 } : DOC_HOST.test(host) ? { pace: 300, lanes: 3 } : { pace: 1200, lanes: 1 };

interface Probe { verdict: "ok" | "broken" | "pending"; http_status: number | null; final_url: string | null; note: string | null; title?: string; body?: string }

async function probe(url: string): Promise<Probe> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url.replace(/ /g, "%20"), { headers: BROWSER_HEADERS, redirect: "follow", signal: ctrl.signal });
    const status = r.status;
    const finalUrl = r.url || url;
    let body = "";
    // Amazon pages run up to 2 MB, their "Product details" rows past the first 1.2 MB (2026-10-20).
    if (DOC_HOST.test(new URL(finalUrl).hostname)) { try { await r.body?.cancel(); } catch { /* ignore */ } }
    else { try { body = (await r.text()).slice(0, 3000000); } catch { body = ""; } }
    if (status === 404 || status === 410) return { verdict: "broken", http_status: status, final_url: finalUrl, note: `HTTP ${status}` };
    // 401/403/429 and 5xx from retailers are robot blocks (Amazon answers
    // 500/503 to datacenter traffic) — the link is not verified, try later.
    if (status === 401 || status === 403 || status === 429 || status >= 500) return { verdict: "pending", http_status: status, final_url: finalUrl, note: `Blocked by the site (HTTP ${status})` };
    if (BOT_RE.test(body) || BOT_BODY_RE.test(body)) return { verdict: "pending", http_status: status, final_url: finalUrl, note: "Blocked by the site (bot check page)" };
    if (NOT_FOUND_RE.test(body)) return { verdict: "broken", http_status: status, final_url: finalUrl, note: "The page says the product was not found" };
    try {
      const a = new URL(url); const b = new URL(finalUrl);
      const rootHost = (h: string) => h.replace(/^www\./, "");
      if (rootHost(a.hostname) !== rootHost(b.hostname)) return { verdict: "broken", http_status: status, final_url: finalUrl, note: `Redirects to ${b.hostname}` };
      if (/password|login|signin/i.test(b.pathname)) return { verdict: "broken", http_status: status, final_url: finalUrl, note: "Redirects to a login / password page" };
      if ((b.pathname === "/" || b.pathname === "") && a.pathname.length > 1) return { verdict: "broken", http_status: status, final_url: finalUrl, note: "Redirects to the home page" };
    } catch { /* keep ok */ }
    if (status >= 200 && status < 400) return { verdict: "ok", http_status: status, final_url: finalUrl, note: null, title: pageTitle(body), body };
    return { verdict: "pending", http_status: status, final_url: finalUrl, note: `HTTP ${status}` };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "No answer in 12 s" : /error sending request|connection|reset|refused/i.test((e as Error).message) ? "Connection dropped by the site" : (e as Error).message.slice(0, 120);
    return { verdict: "pending", http_status: null, final_url: null, note: msg };
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- publish
// The PIM writes the WHERE TO BUY section of the Stylish pages itself, with
// every link of the product's list but the broken ones and the ones that open
// another product or another option of it (user, 2026-10-20: "solo dejar los
// OK" — such a link stays in the PIM to be fixed but leaves the website, and
// comes back when it opens the product again; a link not verified yet is
// shown). Only that section changes — the rest of the page is read from Wix
// and sent back as it is. Pages to (re)write wait in a queue
// (app_settings.where_to_buy_publish_queue) that every check call drains a
// little at a time: Wix lets ~30 changes through, then asks to wait.
const QUEUE_KEY = "where_to_buy_publish_queue";
const WIX_BASE = "https://www.wixapis.com";
const PUBLISH_MAX = 20; // product pages written per call

type PublishStatus = "published" | "up_to_date" | "no_links" | "not_linked" | "not_found" | "error" | "later";
interface PublishResult { sku: string; site: string; status: PublishStatus; error?: string }

// The addresses each product's pages leave out (isHiddenLink: broken, or
// opening another product / option). Kept per SKU: one address can be wrong
// for one product (it opens A-801N) and right for the next (A-801N's own).
async function hiddenUrls(skus: string[]): Promise<Map<string, Set<string>>> {
  const rows: Array<{ sku: string; url: string }> = [];
  for (const part of chunk(skus, 100)) {
    rows.push(...await restAll<{ sku: string; url: string }>(`where_to_buy_links?select=sku,url&url=not.is.null&or=(verdict.eq.broken,sku_check.in.(variant,other))&sku=${inList(part)}`));
  }
  const out = new Map<string, Set<string>>();
  for (const r of rows) { if (!out.has(r.sku)) out.set(r.sku, new Set()); out.get(r.sku)!.add(r.url); }
  return out;
}

async function publishSkus(skus: string[], deadline: number, maxPushes = PUBLISH_MAX): Promise<PublishResult[]> {
  if (!skus.length) return [];
  const [pim, broken, wix, products] = await Promise.all([
    loadPimLinks(skus),
    hiddenUrls(skus),
    restAll<{ site: string; sku: string; wix_product_id: string }>(`wix_links?select=site,sku,wix_product_id&site=${inList(SITES)}&sku=${inList(skus)}`),
    restAll<{ sku: string; brand: string | null }>(`products?select=sku,brand&sku=${inList(skus)}`),
  ]);
  const brand = new Map(products.map((p) => [p.sku, p.brand ?? ""]));
  const linked = new Map(wix.map((w) => [`${w.site}|${w.sku}`, w.wix_product_id]));
  const out: PublishResult[] = [];
  let pushes = 0;
  let wixSaysWait = false;
  for (const sku of skus) {
    if (!brand.has(sku) || /azuni/i.test(brand.get(sku) ?? "")) continue; // never on the Stylish sites
    for (const siteKey of SITES) {
      const id = linked.get(`${siteKey}|${sku}`);
      if (!id) { out.push({ sku, site: siteKey, status: "not_linked" }); continue; }
      if (wixSaysWait || pushes >= maxPushes || Date.now() + 8000 > deadline) { out.push({ sku, site: siteKey, status: "later" }); continue; }
      try {
        const site = resolveWixSite(siteKey);
        const headers = { Authorization: WIX_API_KEY, "wix-site-id": site.siteId, "Content-Type": "application/json" };
        const g = await fetch(`${WIX_BASE}/stores/v1/products/${id}`, { headers, signal: AbortSignal.timeout(20000) });
        if (g.status === 404) { out.push({ sku, site: siteKey, status: "not_found" }); continue; }
        if (g.status === 429) { wixSaysWait = true; out.push({ sku, site: siteKey, status: "later" }); continue; }
        if (!g.ok) throw new Error(`Wix read ${g.status}`);
        const sections = (await g.json()).product?.additionalInfoSections ?? [];
        const all = pim.links.get(sku) ?? [];
        const next = withWhereToBuySection(sections, linksToShow(all, broken.get(sku) ?? new Set()), siteKey, { owned: all.length > 0 });
        if (!next) { out.push({ sku, site: siteKey, status: all.length ? "up_to_date" : "no_links" }); continue; }
        const p = await fetch(`${WIX_BASE}/stores/v1/products/${id}`, {
          method: "PATCH", headers, body: JSON.stringify({ product: { additionalInfoSections: next } }), signal: AbortSignal.timeout(25000),
        });
        pushes += 1;
        if (!p.ok) {
          const text = await p.text();
          if (p.status === 429 || /retry after/i.test(text)) { wixSaysWait = true; out.push({ sku, site: siteKey, status: "later" }); continue; }
          throw new Error(`Wix write ${p.status}: ${text.slice(0, 120)}`);
        }
        out.push({ sku, site: siteKey, status: "published" });
      } catch (e) {
        out.push({ sku, site: siteKey, status: "error", error: (e as Error).message.slice(0, 160) });
      }
    }
  }
  return out;
}

async function readQueue(): Promise<string[]> {
  const r = await rest<Array<{ value: { skus?: string[] } }>>(`app_settings?select=value&key=eq.${QUEUE_KEY}`);
  return r[0]?.value?.skus ?? [];
}
async function writeQueue(skus: string[]) {
  await rest("app_settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: QUEUE_KEY, value: { skus }, updated_at: new Date().toISOString() }),
  });
}
async function enqueuePublish(skus: string[]) {
  if (!skus.length) return;
  const q = new Set(await readQueue());
  const before = q.size;
  for (const s of skus) q.add(s);
  if (q.size !== before) await writeQueue([...q]);
}
// Write a few queued products; the ones Wix or the clock put off stay queued.
async function drainPublishQueue(deadline: number) {
  const queued = await readQueue();
  if (!queued.length) return null;
  const batch = queued.slice(0, Math.ceil(PUBLISH_MAX / 2));
  const res = await publishSkus(batch, deadline);
  const later = new Set(res.filter((r) => r.status === "later").map((r) => r.sku));
  const done = new Set(batch.filter((s) => !later.has(s)));
  const now = await readQueue(); // keep what other calls queued meanwhile
  await writeQueue(now.filter((s) => !done.has(s)));
  // A page just written (or found equal) no longer differs from the PIM.
  const settled = new Set(res.filter((r) => r.status === "published" || r.status === "up_to_date").map((r) => r.sku));
  if (settled.size) {
    const state = await readScanState();
    if (state.differs) {
      await writeScanState({ ...state, differs: Object.fromEntries(Object.entries(state.differs).map(([k, v]) => [k, v.filter((s) => !settled.has(s))])) });
    }
  }
  return {
    published: res.filter((r) => r.status === "published").length,
    errors: res.filter((r) => r.status === "error").map((r) => `${r.sku} ${r.site}: ${r.error}`),
    queued: now.length - done.size,
  };
}

// ---------------------------------------------------------------- sinks direct
// The Sinks Direct links follow the Sinks Direct stores themselves (user,
// 2026-10-20): every scan reads both catalogs and gives each product the
// address of its own page there; a product hidden on that store loses its
// link (a hidden page answers 404) and gets it back once it is shown again.
// A SKU the store does not list is left as it is. Wix writes the address
// as base + path with a double slash ("sinksdirect.ca//product-page/…").
async function refreshSinksDirect(pim: PimLinks, now: string) {
  const changed = new Set<string>();
  const counts: Record<string, { set: number; removed: number }> = {};
  for (const retailer of ["sinksdirect_ca", "sinksdirect_us"]) {
    const store = new Map<string, { visible: boolean; url: string | null }>();
    for (const p of await wixCatalog(retailer)) {
      const sku = skuOf(p);
      if (!sku) continue;
      const url = p.productPageUrl?.base ? `${p.productPageUrl.base}${p.productPageUrl.path ?? ""}`.replace(/^(https?:\/\/[^/]+)\/\/+/, "$1/") : null;
      const visible = p.visible !== false && Boolean(url);
      const prev = store.get(sku);
      if (!prev || (!prev.visible && visible)) store.set(sku, { visible, url });
    }
    const upserts: Array<Record<string, unknown>> = [];
    const removed: string[] = [];
    for (const sku of pim.skus) {
      const page = store.get(sku);
      if (!page) continue;
      const list = pim.links.get(sku) ?? [];
      const current = list.find((l) => l.retailer === retailer);
      if (page.visible && page.url) {
        if (current?.url === page.url) continue;
        upserts.push({ sku, retailer, url: page.url, source: "auto", updated_at: now, updated_by: null });
        pim.links.set(sku, [...list.filter((l) => l.retailer !== retailer), { retailer, url: page.url }]);
        changed.add(sku);
      } else if (current) {
        removed.push(sku);
        pim.links.set(sku, list.filter((l) => l.retailer !== retailer));
        changed.add(sku);
      }
    }
    for (const part of chunk(upserts, 500)) {
      await rest("product_where_to_buy?on_conflict=sku,retailer", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(part) });
    }
    for (const part of chunk(removed, 100)) await rest(`product_where_to_buy?retailer=eq.${retailer}&sku=${inList(part)}`, { method: "DELETE" });
    counts[retailer] = { set: upserts.length, removed: removed.length };
  }
  return { changed: [...changed], counts };
}

// ---------------------------------------------------------------- unlockers
// What one attempt on a link came to:
//   ok / broken  a verdict (broken = 404 / 410 or a "not found" page)
//   soft         weak sign of a dead link (two on different days = broken)
//   none         no answer (blocked, timeout, no credits) — tried again later
//   waiting      a Menards job still running; submitted: one was just sent
//   later        not tried: the call ran out of time
type Kind = "ok" | "broken" | "soft" | "none" | "waiting" | "submitted" | "later";
// What an OK page says about its product (pageProduct.js).
interface OptionLink { model: string | null; name: string | null; subSku: string | null; itemId: string | null; gtin: string | null; url: string }
interface PageRead {
  ids: string[]; options: string[]; gtins: string[]; price: number | null; wasPrice: number | null; currency: string | null;
  inStock: boolean | null; itemId: string | null; source: string | null; optionDefaulted: boolean; gone: boolean; note: string | null;
  subSku: string | null; optionLinks: OptionLink[]; canonical: string | null; optionStale?: boolean; choiceCount?: number | null;
}
interface Outcome { kind: Kind; via?: Method; status?: number | null; note?: string | null; finalUrl?: string | null; jobId?: string; page?: PageRead | null; priceBlind?: boolean; title?: string }

const METHOD_LABEL: Record<Method, string> = { direct: "Direct", brightdata: "Bright Data", scraperapi: "ScraperAPI", scraper: "Bright Data scraper" };
// Time an attempt may take, so a call never starts one it cannot finish.
const METHOD_MS: Record<Method, number> = { direct: 14000, brightdata: 67000, scraperapi: 72000, scraper: 35000 };

const pageTitle = (html: string) => decode((html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
// An address as the services accept it: spaces and non-ASCII letters
// percent-encoded. Bright Data refused Wayfair Canada addresses holding an
// en dash or an "É" ("url must be a valid uri", 31 links on 2026-10-20).
function asUri(url: string): string {
  try { return new URL(url.replace(/ /g, "%20")).href; } catch { return url.replace(/ /g, "%20"); }
}
const PAGE_NOT_FOUND_TITLE = /not found|introuvable|no longer available|isn.t available|couldn.t find|\b404\b|page unavailable/i;
// Not-found pages whose title says nothing (checked 2026-10-19):
// Home Depot USA, Menards ("SORRY!"), Lowe's.
const PAGE_NOT_FOUND_BODY = /The product you are trying to view is not currently available|The page you are looking for can not be found|404 File Not Found/i;
const PAGE_BLOCKED_TITLE = /access denied|pardon our interruption|are you a human|robot or human|verify your identity|just a moment|attention required|robot check|captcha|security check|request unsuccessful/i;
// Denial and challenge pages whose title says nothing: Chrome's own "Access
// to www.lowes.com was denied" (Akamai), Akamai's "You don't have
// authorization", Imperva's challenge, PerimeterX's press-and-hold.
const BLOCK_BODY_RE = /Access to [^<]{1,80} was denied|You don't have authorization to view this page|_Incapsula_Resource|px-captcha|Press &amp; Hold|Press & Hold to confirm/i;
const skuPattern = (sku: string) => new RegExp(`\\b${sku.replace(/[-\s]/g, "").split("").map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[-\\s]?")}\\b`, "i");
// Stores whose answer to the server can be a bot page dressed as a normal
// one (2026-10-19): their direct OK must show the product.
const BOT_PRONE = new Set(["walmart_ca", "walmart_us", "amazon_ca", "amazon_us"]);
// The page names the brand in its text (Amazon: "Visit the STYLISH Store", "Brand: STYLISH").
const BRAND_IN_TEXT = /Visit the (?:stylish|azuni) Store|Brand:?\s*(?:<[^>]*>\s*)*(?:stylish|azuni)\b/i;
// The product's data on the page names its brand (JSON-LD / microdata).
const BRAND_IN_DATA = /"(?:brand|vendor)"\s*:\s*(?:\{[^{}]{0,200}?"name"\s*:\s*)?"\s*(?:stylish|azuni)\b/i;
// A product page names the brand or the SKU in its title — or, when the
// title does not (Best Buy: "33"L x 18"W Double Basin… | Best Buy Canada"),
// in its product data or text. A short SKU (A-02) is only trusted in the title.
function showsProduct(title: string, body: string, sku: string): boolean {
  if (/\b(stylish|azuni)\b/i.test(title) || skuPattern(sku).test(title)) return true;
  if (BRAND_IN_DATA.test(body) || BRAND_IN_TEXT.test(body)) return true;
  return sku.replace(/[-\s]/g, "").length >= 5 && skuPattern(sku).test(body);
}

// A page read through an unlocker: it shows the product when its title names
// the brand or the SKU (every product page seen on 2026-10-19 does: "STYLISH
// 30 inch…", "Stylish® Versa… at Menards®", "Azuni…"). A store's home or
// category page instead is a soft sign; a bot page is no answer at all. An
// OK page is read for its product's model and price.
function judgePage(status: number | null, body: string, row: DueRow, via: Method): Outcome {
  const title = pageTitle(body);
  if (status === 404 || status === 410) return { kind: "broken", via, status, note: `HTTP ${status}` };
  if (PAGE_NOT_FOUND_TITLE.test(title)) return { kind: "broken", via, status, note: "The page says the product was not found" };
  if (PAGE_BLOCKED_TITLE.test(title)) return { kind: "none", via, status, note: `bot check page ("${title.slice(0, 40)}")` };
  // A bot or denial page dressed as a normal one — Amazon's captcha titled
  // just "Amazon.ca", Walmart's "Robot or human?", Lowe's Akamai page titled
  // "www.lowes.com" ("Access to www.lowes.com was denied … HTTP ERROR 403",
  // which made five Lowe's links look dead on 2026-10-20) — is no answer.
  if (BOT_RE.test(body) || BOT_BODY_RE.test(body) || BLOCK_BODY_RE.test(body)) return { kind: "none", via, status, note: "bot check page" };
  // A page that shows the product is OK even if a "not available" sentence
  // sits in it: Home Depot USA's live E-120 page (new, regional stock) carried
  // "The product you are trying to view is not currently available" and was
  // marked Broken on 2026-10-20. Those sentences only count on a page that
  // does not show the product (Home Depot's real not-found page has no title).
  // The store's reader finding a product counts too: Wayfair keeps its home
  // page's title on a listing moved to a new id (TKJS1142 → C003260802).
  const page = status !== null && status >= 200 && status < 300 ? readProductPage(body, row.retailer, row.url) : null;
  if (page && !page.gone && (page.ids.length || page.price !== null)) return { kind: "ok", via, status, note: null, page, title };
  if (status !== null && status >= 200 && status < 300 && title && showsProduct(title, body, row.sku)) {
    return { kind: "ok", via, status, note: null, page, title };
  }
  if (PAGE_NOT_FOUND_BODY.test(body)) return { kind: "broken", via, status, note: "The page says the product was not found" };
  if (status !== null && status >= 200 && status < 300 && title) return { kind: "soft", via, status, note: `Opens a page without the product: "${title.slice(0, 80)}"` };
  return { kind: "none", via, status, note: status ? `HTTP ${status}, empty page` : "no page" };
}

// Bright Data turned a burst away ("Your account exceeded the allowed rate
// limits" on 611 links of the first full pass, 2026-10-19) until the account
// was verified. On 2026-10-20 that answer no longer came, even 60 at once to
// one store (only Bright Data's per-site "global adaptive rate limit" on 7 of
// them): 20 pages at a time per call (each store at most 2), and after a
// rate-limit answer every lane waits 20 s. A link the limit turned away is
// tried again soon, not counted as a failure.
const brightData = { inFlight: 0, coolUntil: 0, limited: 0 };
const BD_MAX_IN_FLIGHT = 20;
const RATE_LIMIT_RE = /rate limit/i;
async function viaBrightData(row: DueRow, deadline: number): Promise<Outcome> {
  const url = row.url;
  if (!BRIGHTDATA_API_TOKEN) return { kind: "none", via: "brightdata", note: "not configured" };
  while (brightData.inFlight >= BD_MAX_IN_FLIGHT || Date.now() < brightData.coolUntil) {
    if (Date.now() + METHOD_MS.brightdata > deadline) return { kind: "later", via: "brightdata" };
    await new Promise((ok) => setTimeout(ok, 500));
  }
  brightData.inFlight += 1;
  try {
    const r = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: { Authorization: `Bearer ${BRIGHTDATA_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ zone: BRIGHTDATA_ZONE, url: asUri(url), format: "json" }),
      signal: AbortSignal.timeout(65000),
    });
    if (r.status === 429) { brightData.limited += 1; brightData.coolUntil = Date.now() + 20000; return { kind: "later", via: "brightdata" }; }
    if (!r.ok) return { kind: "none", via: "brightdata", note: `HTTP ${r.status} from the service` };
    const j = await r.json() as { status_code?: number; headers?: Record<string, string>; body?: string };
    const code = j.status_code ?? null;
    if (RATE_LIMIT_RE.test(j.headers?.["x-brd-error"] ?? "")) { brightData.limited += 1; brightData.coolUntil = Date.now() + 20000; return { kind: "later", via: "brightdata" }; }
    // 5xx / 403 / 429 here are the store or the unlocker turning the page down.
    if (code === null || code >= 500 || code === 403 || code === 429) return { kind: "none", via: "brightdata", status: code, note: j.headers?.["x-brd-error"] ?? `HTTP ${code}` };
    return judgePage(code, j.body ?? "", row, "brightdata");
  } catch (e) {
    return { kind: "none", via: "brightdata", note: (e as Error).name === "TimeoutError" ? "no answer in 60 s" : (e as Error).message.slice(0, 80) };
  } finally { brightData.inFlight -= 1; }
}

// ScraperAPI's free plan: ~1,000 credits a month, 5 requests at a time. The
// balance is read once per call and spent conservatively (10 per page).
const scraperApi = { credits: 0, inFlight: 0 };
async function refreshScraperCredits() {
  scraperApi.credits = 0;
  if (!SCRAPERAPI_KEY) return;
  try {
    const r = await fetch(`https://api.scraperapi.com/account?api_key=${SCRAPERAPI_KEY}`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) scraperApi.credits = Number((await r.json()).creditsLeft ?? 0);
  } catch { /* leave 0: ScraperAPI is skipped this call */ }
}
async function viaScraperApi(row: DueRow): Promise<Outcome> {
  const url = row.url;
  if (scraperApi.credits < 25) return { kind: "none", via: "scraperapi", note: SCRAPERAPI_KEY ? "no credits left this month" : "not configured" };
  while (scraperApi.inFlight >= 4) await new Promise((ok) => setTimeout(ok, 500));
  scraperApi.inFlight += 1;
  scraperApi.credits -= 10;
  try {
    const r = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(asUri(url))}`, { signal: AbortSignal.timeout(70000) });
    const body = await r.text();
    if (r.status === 404 || r.status === 410) return { kind: "broken", via: "scraperapi", status: r.status, note: `HTTP ${r.status}` };
    if (r.status >= 400) return { kind: "none", via: "scraperapi", status: r.status, note: r.status === 500 ? "could not open the page" : `HTTP ${r.status}` };
    return judgePage(r.status, body, row, "scraperapi");
  } catch (e) {
    return { kind: "none", via: "scraperapi", note: (e as Error).name === "TimeoutError" ? "no answer in 70 s" : (e as Error).message.slice(0, 80) };
  } finally { scraperApi.inFlight -= 1; }
}

// Stores read through one of Bright Data's ready-made scrapers (Web Scraper
// API) instead of their pages: a call sends the store's due links as one
// snapshot job (`job_id`) and a later call reads the snapshot (minutes).
//   Menards (Imperva + hCaptcha) — dataset "Menards Products", tested
//     2026-10-20 on links of known answer: B-108G and S-613W live (title,
//     brand, our SKU as `mpn`), B-112N gone ("HTTP 404 — product page not
//     found", error_code dead_page), one pass of ~2 minutes. The Web Unlocker
//     gave up on some live Menards pages (B-108G).
//   Lowe's — dataset "Lowes.com", since 2026-10-20: Lowe's put a captcha in
//     front of the Web Unlocker ("captcha or protection page found" on 70
//     links, with or without a US exit) while its scraper read the same links
//     (B-112C, P-227H, S-306TG: model_number, upc, final_price /
//     initial_price, in_stock).
type ScrapedRecord = Record<string, unknown>;
interface ScraperStore { dataset: string; label: string; read: (rec: ScrapedRecord, siblings: ScrapedRecord[]) => PageRead | null }
const SCRAPERS: Record<string, ScraperStore> = {
  menards: { dataset: "gd_motp6b7s1n9zlq6lwj", label: "Menards", read: (rec, siblings) => (rec.title ? menardsRead(rec, siblings) : null) },
  lowes_us: { dataset: "gd_lnvl79pfftqh18u2o", label: "Lowe's", read: (rec) => lowesRecordRead(rec) },
};
const SCRAPER_RETAILERS = Object.keys(SCRAPERS);
const SCRAPER_BATCH = 300;      // links per job
const SCRAPER_GIVEUP_HOURS = 3; // a job still running after 3 h: no answer

// The record of the address itself among the ones the scraper returned for
// it: the same page (address without its query), else the same store id
// (Menards ".../p-1642874277884313-c-8509.htm"), else the first one (the
// scraper lists the page's own product first).
const recordPath = (u: unknown) => String(u ?? "").split(/[?#]/)[0].toLowerCase().replace(/\/+$/, "");
const menardsId = (u: unknown) => String(u ?? "").match(/\/p-(\d{6,})(?:-c-|\.htm)/i)?.[1] ?? null;
function ownRecord(recs: ScrapedRecord[], url: string): ScrapedRecord | null {
  if (!recs.length) return null;
  const id = menardsId(url);
  return recs.find((r) => r.url && recordPath(r.url) === recordPath(url))
    ?? (id ? recs.find((r) => String(r.item_id ?? "") === id || menardsId(r.url) === id) : undefined)
    ?? recs[0];
}

async function checkScrapers(leads: DueRow[]): Promise<Array<{ row: DueRow; o: Outcome }>> {
  const byStore = new Map<string, DueRow[]>();
  for (const r of leads) { if (!byStore.has(r.retailer)) byStore.set(r.retailer, []); byStore.get(r.retailer)!.push(r); }
  return (await Promise.all([...byStore].map(([retailer, rows]) => checkScraper(SCRAPERS[retailer], rows)))).flat();
}

async function checkScraper(store: ScraperStore, leads: DueRow[]): Promise<Array<{ row: DueRow; o: Outcome }>> {
  const out: Array<{ row: DueRow; o: Outcome }> = [];
  if (!leads.length) return out;
  if (!BRIGHTDATA_API_TOKEN) return leads.map((row) => ({ row, o: { kind: "none", via: "scraper", note: "not configured" } }));
  const auth = { Authorization: `Bearer ${BRIGHTDATA_API_TOKEN}`, "Content-Type": "application/json" };
  // Jobs in flight: read the ones that are done.
  const byJob = new Map<string, DueRow[]>();
  for (const r of leads) if (r.job_id) { if (!byJob.has(r.job_id)) byJob.set(r.job_id, []); byJob.get(r.job_id)!.push(r); }
  for (const [job, rows] of byJob) {
    try {
      const p = await (await fetch(`https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(job)}`, { headers: auth, signal: AbortSignal.timeout(20000) })).json();
      if (p.status !== "ready" && p.status !== "failed") {
        const hours = (Date.now() - Date.parse(rows[0].job_at ?? "")) / 3600e3;
        for (const row of rows) out.push({ row, o: hours >= SCRAPER_GIVEUP_HOURS ? { kind: "none", via: "scraper", note: `the ${store.label} scraper gave no answer` } : { kind: "waiting", via: "scraper" } });
        continue;
      }
      const s = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(job)}?format=json`, { headers: auth, signal: AbortSignal.timeout(60000) });
      const records = s.ok ? await s.json().catch(() => []) : [];
      // The scraper returns, for each address, one record per finish of the
      // product — the page's own and its siblings', all under the same input
      // (K-142N's link also brings K-142S's record). Taking the last one gave
      // the K-142N link K-142S's model and price (2026-10-20).
      const byInput = new Map<string, Array<Record<string, unknown>>>();
      for (const rec of Array.isArray(records) ? records : []) {
        const u = (rec?.input as { url?: string } | undefined)?.url ?? (rec?.url as string | undefined);
        if (!u) continue;
        if (!byInput.has(u)) byInput.set(u, []);
        byInput.get(u)!.push(rec);
      }
      for (const row of rows) {
        const recs = byInput.get(row.url) ?? byInput.get(row.url.replace(/ /g, "%20")) ?? [];
        const rec = ownRecord(recs, row.url);
        const page = rec && !rec.error ? store.read(rec, recs.filter((x) => x !== rec)) : null;
        if (!rec) out.push({ row, o: { kind: "none", via: "scraper", note: `the ${store.label} scraper returned nothing for it` } });
        else if (rec.error_code === "dead_page" || /\b404\b|not found/i.test(String(rec.error ?? ""))) out.push({ row, o: { kind: "broken", via: "scraper", status: 404, note: `${store.label}: the product page is gone (404)` } });
        else if (rec.error) out.push({ row, o: { kind: "none", via: "scraper", note: `${store.label} scraper: ${String(rec.error).slice(0, 80)}` } });
        else if (page?.gone) out.push({ row, o: { kind: "broken", via: "scraper", status: 200, note: page.note ?? `${store.label} no longer sells it`, page } });
        else if (page) out.push({ row, o: { kind: "ok", via: "scraper", status: 200, page } });
        else out.push({ row, o: { kind: "none", via: "scraper", note: `the ${store.label} scraper read no product` } });
      }
    } catch (e) {
      for (const row of rows) out.push({ row, o: { kind: "none", via: "scraper", note: (e as Error).message.slice(0, 80) } });
    }
  }
  // New ones: one job for the batch.
  const fresh = leads.filter((r) => !r.job_id).slice(0, SCRAPER_BATCH);
  if (fresh.length) {
    try {
      const r = await fetch(`https://api.brightdata.com/datasets/v3/trigger?dataset_id=${store.dataset}&include_errors=true&format=json`, {
        method: "POST", headers: auth, body: JSON.stringify(fresh.map((x) => ({ url: x.url }))), signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => ({}));
      for (const row of fresh) out.push({ row, o: j.snapshot_id ? { kind: "submitted", via: "scraper", jobId: j.snapshot_id } : { kind: "none", via: "scraper", note: `job not accepted (HTTP ${r.status})` } });
    } catch (e) {
      for (const row of fresh) out.push({ row, o: { kind: "none", via: "scraper", note: (e as Error).message.slice(0, 80) } });
    }
  }
  return out;
}

// The server's own probe reads these stores' pages without their price
// (Amazon: no buy box for a US address — 2026-10-20): its reading keeps the
// model check but leaves the last price as it was.
const PRICE_BLIND = new Set(["amazon_ca", "amazon_us"]);

// One link: its route's methods in order until one answers. The server's own
// probe keeps its finer rules (redirects to home / login pages). An
// unlocker's "page without the product" is kept for last: the next method may
// still open the product (a store can answer one service a page of its own).
// Vatero's Shopify store converts its prices to the visitor's currency: from
// the server (a US address) it answered USD 90 for a CAD 115 sink, so 161 of
// its 167 readings were in USD and Price Alignment left them out (2026-10-21).
// Asking for Canada (?country=CA) gives the Canadian page. Only the request
// changes: the link kept and published stays as it is.
const ASK_PARAMS: Record<string, Record<string, string>> = { vatero: { country: "CA" } };
function requestUrl(retailer: string, url: string): string {
  const params = ASK_PARAMS[retailer];
  if (!params) return url;
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.href;
  } catch { return url; }
}

async function checkRow(row: DueRow, deadline: number): Promise<Outcome> {
  row = { ...row, url: requestUrl(row.retailer, row.url) };
  const misses: string[] = [];
  let last: Outcome = { kind: "none", note: "not tried" };
  let provisional: Outcome | null = null;
  for (const m of routeFor(row.retailer, row.host ?? "")) {
    if (Date.now() + METHOD_MS[m] > deadline) return provisional ?? (misses.length ? { kind: "none", note: misses.join(" · ") } : { kind: "later" });
    let o: Outcome;
    if (m === "direct") {
      const p = await probe(row.url);
      o = { kind: p.verdict === "pending" ? "none" : p.verdict, via: "direct", status: p.http_status, finalUrl: p.final_url, note: p.note, title: p.title };
      // An open page counts only when it shows the product (user, 2026-10-19):
      // Walmart and Amazon sometimes answer a bot check that looks like a
      // normal page ("Robot or human?", "Verify Your Identity", Amazon's
      // captcha titled "Amazon.ca") — then the next service of the route tries.
      // Only there: a small store's page may not name the brand ("BAMBOO
      // CUTTING BOARD – Cabinet Depot") and is not a bot page.
      if (o.kind === "ok" && p.body !== undefined && BOT_PRONE.has(row.retailer) && !showsProduct(p.title ?? "", p.body, row.sku)) {
        o = { kind: "none", via: "direct", status: p.http_status, note: `the page does not show the product ("${(p.title ?? "").slice(0, 50)}")` };
      }
      if (o.kind === "ok" && p.body !== undefined) {
        o.page = readProductPage(p.body, row.retailer, row.url);
        if (PRICE_BLIND.has(row.retailer)) o.priceBlind = true;
      }
    } else if (m === "brightdata") o = await viaBrightData(row, deadline);
    else if (m === "scraperapi") o = await viaScraperApi(row);
    else o = { kind: "none", via: "scraper", note: "goes through its store's scraper batch" }; // never reached: checkScrapers
    if (o.kind === "soft") { provisional ??= o; misses.push(`${METHOD_LABEL[m]}: ${o.note ?? "no product"}`); continue; }
    if (o.kind !== "none") return o;
    misses.push(`${METHOD_LABEL[m]}: ${o.note ?? "no answer"}`);
    last = o;
  }
  return provisional ?? { ...last, note: misses.join(" · ") };
}

// ---------------------------------------------------------------- check
interface DueRow { id: string; sku: string; url: string; host: string | null; retailer: string; verdict: string; note: string | null; fail_count: number; signal_count: number; signal_at: string | null; job_id: string | null; job_at: string | null; sku_check?: string | null; site?: string }
const DUE_COLUMNS = "id,site,sku,url,host,retailer,verdict,note,fail_count,signal_count,signal_at,job_id,job_at,sku_check";
// The title of the page names the SKU: it is that product's page.
const titleNamesSku = (o: Outcome, sku: string) => Boolean(o.title) && skuPattern(sku).test(o.title ?? "");

const at = (ms: number) => new Date(Date.now() + ms).toISOString();

// How many soft signs make a link Broken, and how far apart. Menards needs
// 4 tries 6 h apart: its unlocker also gives up on some LIVE pages (B-108G
// opened in the user's browser on 2026-10-20 after a "gave up"), while a dead
// one fails every time. A sign counts only that far from the previous one
// (`signal_at`: a check run again sooner — a product's links rechecked from
// the PIM — changes nothing), and the count starts over after a week.
const SOFT_RULE: Record<string, { strikes: number; everyHours: number }> = {
  menards: { strikes: 4, everyHours: 6 },
  default: { strikes: 2, everyHours: BROKEN_HOURS },
};
const SIGN_FORGOTTEN_MS = 7 * 86400e3;

// One answer, judged for one row: the same page can be the right product for
// one SKU and another product for the next (a listing several SKUs link).
//   - the store says it no longer sells the product (Lowe's "no longer sold")
//     → Broken at once;
//   - a page on ANOTHER PIM product (another family: KB Authority's links of
//     2026-10-20 opened B-122G for B-108G, a faucet combo for a drain) → a soft
//     sign: twice, two days apart, and the link is Broken ("Opens another
//     product") — a store can show a sibling for a while. Another option of
//     the same family stays OK, flagged "variant" for the link to be fixed;
//   - an open page whose store reader finds no product on it (a brand,
//     category or search page the link was sent to: Wayfair's STYLISH brand
//     page for A-908, KB Authority's sink category for S-306TG) → the same
//     soft sign. `unreadable` lists the stores where most pages of this call
//     read as nothing — a store that changed its pages — where it is not
//     counted.
type Judged = Outcome & { check?: { check: string; model: string | null } | null };
function judgedFor(row: DueRow, o: Outcome, catalog: ReturnType<typeof pimCatalog>, unreadable: Set<string>): Judged {
  if (o.kind !== "ok" || o.page === undefined) return o;
  if (o.page === null) {
    // Not when the page's own title names the SKU (a product page the reader
    // did not understand), nor on a page the server's probe reads in part.
    return SURE_READERS.has(row.retailer) && !unreadable.has(row.retailer) && !o.priceBlind && !titleNamesSku(o, row.sku)
      ? { ...o, kind: "soft", note: "Opens a page without the product (a brand, category or search page)" }
      : o;
  }
  if (o.page.gone) return { ...o, kind: "broken", note: o.page.note ?? "The store no longer sells it" };
  const check = skuCheck(o.page, row.sku, catalog);
  if (check?.check === "other") return { ...o, kind: "soft", check, note: `Opens another product: ${check.model}` };
  return { ...o, check };
}

// The stores whose reader cannot be trusted to call a page "not a product
// page" right now: a page that reads as nothing counts as a sign only when
// the same store's reader read most of its pages of the last 3 days (this
// call included) — a store that changed its pages reads as nothing
// everywhere, and its links must not turn Broken for it.
async function unreadableStores(answers: Array<{ row: DueRow; o: Outcome }>): Promise<Set<string>> {
  const tally = new Map<string, { read: number; blank: number }>();
  for (const { row, o } of answers) {
    if (o.kind !== "ok" || o.page === undefined) continue;
    const t = tally.get(row.retailer) ?? { read: 0, blank: 0 };
    if (o.page === null) t.blank += 1; else t.read += 1;
    tally.set(row.retailer, t);
  }
  const out = new Set<string>();
  const since = new Date(Date.now() - 72 * 3600e3).toISOString();
  const count = async (filter: string) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/where_to_buy_links?select=id&${filter}`, {
      method: "HEAD", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact" },
    });
    return Number(r.headers.get("content-range")?.split("/")[1] ?? 0);
  };
  for (const [retailer, t] of tally) {
    if (!t.blank) continue;
    // Rows (both sites carry each address) read lately with data, and blank.
    const [read, blank] = await Promise.all([
      count(`retailer=eq.${retailer}&read_at=gte.${since}&or=(price.not.is.null,page_model.not.is.null)`),
      count(`retailer=eq.${retailer}&read_at=gte.${since}&price=is.null&page_model=is.null`),
    ]);
    const good = read / 2 + t.read;
    const bad = blank / 2 + t.blank;
    if (good < 3 || bad >= good) { out.add(retailer); console.warn(`[where-to-buy] ${retailer}: ${t.blank} page(s) read as nothing, the reader read ${good} of ${good + bad} lately — not counted as signs`); }
  }
  return out;
}

// What the page said about its product, as columns (pageProduct.js). An OK
// page whose product data the reader could not find leaves an empty reading;
// a dead page drops the last one.
function readingFor(o: Judged, now: string): Partial<Reading> {
  if (o.page === undefined) return o.kind === "broken" ? NO_READING : {};
  if (!o.page) return o.priceBlind ? {} : { ...NO_READING, read_at: now };
  const model = {
    page_model: o.check?.model ?? o.page.ids[0] ?? null, page_item_id: o.page.itemId, sku_check: o.check?.check ?? null, page_note: o.page.note,
    page_options: o.page.optionLinks?.length ? o.page.optionLinks : null,
  };
  if (o.priceBlind) return model; // the last price read stays as it was
  return { ...model, price: o.page.price, was_price: o.page.wasPrice, currency: o.page.currency, in_stock: o.page.inStock, read_at: now };
}

// What an outcome writes on the row.
function patchFor(row: DueRow, o: Judged, now: string): Record<string, unknown> | null {
  const clearJob = { job_id: null, job_at: null };
  const reading = readingFor(o, now);
  const verdictPatch = (verdict: "ok" | "broken", note: string | null, signals: number) => ({
    verdict, note, http_status: o.status ?? null, final_url: verdict === "broken" ? o.finalUrl ?? null : null,
    checked_at: now, checked_via: o.via === "scraper" ? "brightdata" : o.via ?? null,
    fail_count: 0, signal_count: signals, signal_at: null, ...clearJob,
    next_check_at: at((verdict === "ok" ? OK_HOURS : BROKEN_HOURS) * 3600e3),
    ...reading,
  });
  switch (o.kind) {
    case "ok": return verdictPatch("ok", null, 0);
    case "broken": return verdictPatch("broken", o.note ?? null, 0);
    case "soft": {
      const rule = o.check ? SOFT_RULE.default : SOFT_RULE[row.retailer] ?? SOFT_RULE.default;
      const last = row.signal_at ? Date.parse(row.signal_at) : null;
      const since = last === null ? Infinity : Date.now() - last;
      // A first sign (or one after a week), a sign far enough from the last
      // one, or a sign too soon that changes nothing.
      const counts = last === null || since > SIGN_FORGOTTEN_MS || since >= rule.everyHours * 3600e3 - 10 * 60e3;
      const signals = last === null || since > SIGN_FORGOTTEN_MS ? 1 : counts ? row.signal_count + 1 : row.signal_count;
      if (signals >= rule.strikes) return verdictPatch("broken", `${o.note} — on ${rule.strikes} checks ${rule.everyHours} h apart`, signals);
      // Not enough yet: keep the verdict, look again later.
      return {
        signal_count: signals, signal_at: counts ? now : row.signal_at, fail_count: 0, ...clearJob,
        next_check_at: counts ? at(rule.everyHours * 3600e3) : new Date(last! + rule.everyHours * 3600e3).toISOString(), ...reading,
        ...(row.verdict === "pending" ? { note: `${o.note} (${signals} of ${rule.strikes} checks before calling it broken)`, checked_at: now } : {}),
      };
    }
    case "none": {
      const fails = row.fail_count + 1;
      return {
        fail_count: fails, ...clearJob, next_check_at: at(Math.min(RETRY_HOURS * fails, 24) * 3600e3),
        ...(row.verdict === "pending" ? { note: `Not verified yet — ${o.note ?? "no answer"}`, checked_at: now } : {}),
      };
    }
    case "submitted": return {
      job_id: o.jobId, job_at: now, next_check_at: at(JOB_POLL_MIN * 60e3),
      ...(row.verdict === "pending" ? { note: `Opening through Bright Data's ${SCRAPERS[row.retailer]?.label ?? ""} scraper (takes a few minutes)` } : {}),
    };
    case "waiting": return { next_check_at: at(20 * 60e3) };
    case "later": return { next_check_at: o.via === "brightdata" ? at(5 * 60e3) : now };
  }
  return null;
}

// Links due: never checked, or their next check has come. Missing and
// manual rows are never probed.
const dueFilter = () => `url=not.is.null&verdict=not.in.(missing,manual)&or=(next_check_at.is.null,next_check_at.lte.${new Date().toISOString()})`;

// A batch takes two pools so neither starves the other: the links of the
// stores read through an unlocker (one call opens ~40 of them since the
// account's verification, 2026-10-20; links never verified first), and the
// links the server opens itself (fast, free).
const UNLOCKER_RETAILERS = Object.entries(ROUTES).filter(([, r]) => r[0] !== "direct" && r[0] !== "scraper").map(([k]) => k);
const SCRAPER_POOL = 900; // rows (both sites); each store goes as one scraper job
const UNLOCKER_BATCH = 72;
const DIRECT_BATCH = 250;
// At most this many rows of one host in a batch (its lanes cannot open more
// in one call): a store with a long backlog — a dealer's 640 new links, BB&B
// and Overstock waiting for ScraperAPI — never fills a batch and holds the
// other stores back. Each pool is read 1,000 rows deep for that (the API's
// page): at 360 rows, 191 pending Aquarina links and two stores' re-checks
// filled the window and Amazon.ca got no turn for 15 minutes (2026-10-20).
const UNLOCKER_PER_HOST = 12;
const DIRECT_PER_HOST = 40;
function capPerHost(rows: DueRow[], perHost: number, total: number): DueRow[] {
  const taken = new Map<string, number>();
  const out: DueRow[] = [];
  for (const r of rows) {
    const h = (r.host ?? "").replace(/^www\./, "");
    const n = taken.get(h) ?? 0;
    if (n >= perHost) continue;
    taken.set(h, n + 1);
    out.push(r);
    if (out.length >= total) break;
  }
  return out;
}

async function check(opts: { limit?: number; skus?: string[]; dueOnly?: boolean } = {}) {
  const started = Date.now();
  const deadline = started + BATCH_MS;
  // Due rows beyond a batch (or a host's share of it) wait for the next call.
  let leftDue = false;
  const pool = async (filter: string, order: string, depth: number, perHost: number, total: number) => {
    const due = await rest<DueRow[]>(`where_to_buy_links?select=${DUE_COLUMNS}&${dueFilter()}&${filter}&order=${order}&limit=${depth}`, { headers: { Prefer: "count=none" } });
    const taken = capPerHost(due, perHost, total);
    if (taken.length < due.length) leftDue = true;
    return taken;
  };
  const rows = opts.skus?.length
    ? await rest<DueRow[]>(`where_to_buy_links?select=${DUE_COLUMNS}&sku=${inList(opts.skus)}&${opts.dueOnly ? dueFilter() : "url=not.is.null&verdict=not.in.(missing,manual)"}`, { headers: { Prefer: "count=none" } })
    : [
      ...await pool(`retailer=${inList(UNLOCKER_RETAILERS)}`, "verdict.desc,next_check_at.asc.nullsfirst", 1000, UNLOCKER_PER_HOST, UNLOCKER_BATCH),
      ...await pool(`retailer=not.${inList([...UNLOCKER_RETAILERS, ...SCRAPER_RETAILERS])}`, "next_check_at.asc.nullsfirst", 1000, DIRECT_PER_HOST, opts.limit ?? DIRECT_BATCH),
      ...await rest<DueRow[]>(`where_to_buy_links?select=${DUE_COLUMNS}&${dueFilter()}&retailer=${inList(SCRAPER_RETAILERS)}&order=next_check_at.asc.nullsfirst&limit=${SCRAPER_POOL}`, { headers: { Prefer: "count=none" } }),
    ];
  // Claim the batch so an overlapping call (cron chain + UI) skips it; every
  // outcome writes its own next_check_at, and a link this call never reaches
  // is due again when the claim runs out.
  const lease = at(LEASE_MIN * 60e3);
  for (const ids of chunk(rows.map((r) => r.id), 200)) {
    await rest(`where_to_buy_links?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify({ next_check_at: lease }) });
  }
  if (rows.some((r) => routeFor(r.retailer, r.host ?? "").includes("scraperapi"))) await refreshScraperCredits();

  // The same address often sits on both Stylish sites (and on several
  // variants): it is opened once and its answer goes to every row.
  const sameUrl = new Map<string, DueRow[]>();
  for (const r of rows) { if (!sameUrl.has(r.url)) sameUrl.set(r.url, []); sameUrl.get(r.url)!.push(r); }
  const leads = [...sameUrl.values()].map((list) => list.find((r) => r.job_id) ?? list[0]);

  // One queue per host. Sites read through an unlocker take 3 lanes (the
  // service spreads them over its own addresses); the server's own probe
  // keeps one paced lane per host.
  // Menards and Lowe's go as one batch per store to their scraper
  // (checkScrapers), the rest by host.
  const byHost = new Map<string, DueRow[]>();
  for (const r of leads) {
    if (SCRAPERS[r.retailer]) continue;
    const h = (r.host ?? "").replace(/^www\./, "");
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h)!.push(r);
  }
  const answers: Array<{ row: DueRow; o: Outcome }> = [];
  const scraped = checkScrapers(leads.filter((r) => SCRAPERS[r.retailer])).then((res) => { answers.push(...res); });
  await Promise.all([scraped, ...[...byHost.entries()].map(async ([host, list]) => {
    const unlocker = !routeFor(list[0].retailer, host).every((m) => m === "direct");
    // 3 lanes per store through an unlocker (slow stores — Home Depot Canada,
    // Aquarina — take 30–60 s a page; 2 lanes left them at ~100 pages an hour).
    const { pace, lanes } = unlocker ? { pace: 500, lanes: 3 } : laneConfig(host);
    let next = 0;
    const lane = async () => {
      while (next < list.length && Date.now() - started <= START_MS) {
        const row = list[next++];
        const o = await checkRow(row, deadline);
        answers.push({ row, o });
        await new Promise((ok) => setTimeout(ok, pace));
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
  })]);
  // Each row of an address gets the answer judged for its own SKU.
  const catalog = pimCatalog(answers.some(({ o }) => o.page) ? await restAll<{ sku: string; upc: string | null; family_number: number | null }>("products?select=sku,upc:attributes->>upc,family_number") : []);
  const unreadable = await unreadableStores(answers);
  const results = answers.flatMap(({ row, o }) => sameUrl.get(row.url)!.map((r) => ({ row: r, o: judgedFor(r, o, catalog, unreadable) })));

  const now = new Date().toISOString();
  const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
  const republish = new Set<string>();
  for (const { row, o } of results) {
    const patch = patchFor(row, o, now);
    if (!patch) continue;
    // A link that leaves the pages (broken, or opening another product) or
    // comes back to them: its product's pages are written again. (A dealer's
    // link, watched for price only, is on no page.)
    const hiddenBefore = isHiddenLink(row.verdict, row.sku_check);
    const hiddenAfter = isHiddenLink(typeof patch.verdict === "string" ? patch.verdict : row.verdict, "sku_check" in patch ? patch.sku_check as string | null : row.sku_check);
    if (hiddenBefore !== hiddenAfter && SITES.includes(row.site ?? "")) republish.add(row.sku);
    const key = JSON.stringify(patch);
    if (!groups.has(key)) groups.set(key, { patch, ids: [] });
    groups.get(key)!.ids.push(row.id);
  }
  // A reading makes nearly every patch its own (one per address read), so the
  // writes go six at a time: a call reading 300 pages must finish before the
  // runtime's ~150 s cut.
  const writes = [...groups.values()].flatMap((g) => chunk(g.ids, 200).map((ids) => ({ ids, patch: g.patch })));
  for (const part of chunk(writes, 6)) {
    await Promise.all(part.map((w) => rest(`where_to_buy_links?id=in.(${w.ids.join(",")})`, { method: "PATCH", body: JSON.stringify(w.patch) })));
  }
  // Links of the batch this call never started go back to due now.
  const touched = new Set(results.map((r) => r.row.id));
  const untouched = rows.filter((r) => !touched.has(r.id)).map((r) => r.id);
  for (const ids of chunk(untouched, 200)) await rest(`where_to_buy_links?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify({ next_check_at: now }) });

  const byKind: Record<string, number> = {};
  const byVia: Record<string, number> = {};
  for (const { o } of answers) {
    byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
    if (o.via && (o.kind === "ok" || o.kind === "broken")) byVia[o.via] = (byVia[o.via] ?? 0) + 1;
  }
  // A link that turned broken leaves its pages; one that answers again comes back.
  await enqueuePublish([...republish]);
  const published = !opts.skus?.length && Date.now() + 20000 < deadline ? await drainPublishQueue(deadline) : null;
  const morePending = !opts.skus?.length && (untouched.length > 0 || leftDue);
  return {
    published,
    checked: results.filter((r) => r.o.kind !== "later").length, addresses: answers.length, morePending, byKind, byVia,
    // Bright Data answers "rate limit" (each one pauses its lanes 20 s).
    brightDataLimited: brightData.limited,
    scraperCredits: scraperApi.credits, ms: Date.now() - started,
    ...(opts.skus?.length ? {
      links: results.filter(({ row }) => opts.skus!.includes(row.sku)).filter(({ row }, i, all) => all.findIndex((x) => x.row.url === row.url && x.row.sku === row.sku) === i).map(({ row, o }) => ({
        sku: row.sku, retailer: row.retailer, url: row.url, kind: o.kind, via: o.via ?? null, note: o.note ?? null,
        page: o.page ? { model: o.check?.model ?? o.page.ids[0] ?? null, check: o.check?.check ?? null, price: o.page.price, wasPrice: o.page.wasPrice, currency: o.page.currency, inStock: o.page.inStock, note: o.page.note, gone: o.page.gone, source: o.page.source } : o.page,
      })),
    } : {}),
  };
}

// ---------------------------------------------------------------- promotion days
// The morning a promotion starts or ends for a market — a monthly promotion
// for its members of that market, a flash deal / special event on each
// marketplace it runs on — the store pages of its products are read again
// (cron where-to-buy-promo-reread-daily, 13:10 UTC = 9:10 Eastern, once the
// stores have switched their prices), so Price Alignment compares them with
// the new expected price that same day instead of leaving them out until
// their 3-day turn (user, 2026-10-20: "esto hay que hacerlo sí o sí"). Only
// the stores Price Alignment reads from their pages (PAGE_STORES), only OK
// or not-yet-verified links, and not a page read in the last 6 hours. The
// checks themselves run in the usual batches (every 10 minutes).
interface PromoRow {
  name: string | null; kind: string | null; status: string | null; period: string; marketplaces: string[] | null;
  starts_on: string | null; ends_on: string | null; ca_starts_on: string | null; ca_ends_on: string | null; us_starts_on: string | null; us_ends_on: string | null;
  promotion_prices: Array<{ sku: string; in_ca: boolean | null; in_us: boolean | null; promo_price_cad: number | null; promo_price_usd: number | null }>;
}
const countRows = async (filter: string) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/where_to_buy_links?select=id&${filter}`, {
    method: "HEAD", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact" },
  });
  return Number(r.headers.get("content-range")?.split("/")[1] ?? 0);
};

async function promoReread(opts: { asOf?: string; dryRun?: boolean } = {}) {
  const today = opts.asOf && /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf) ? opts.asOf : etToday();
  const since = prevPeriod(prevPeriod(periodOfDay(today)));
  const promos = await rest<PromoRow[]>(`promotions?select=name,kind,status,period,marketplaces,${PROMO_DATE_COLUMNS},promotion_prices(sku,in_ca,in_us,promo_price_cad,promo_price_usd)&period=gte.${since}`);
  const due = new Map<string, Set<string>>(); // retailer → SKUs
  const changes: string[] = [];
  for (const p of promos) {
    const monthly = (p.kind ?? "monthly") === "monthly";
    // A monthly promotion counts once activated (as its expected prices do);
    // a flash deal or special event by its dates (it stays "draft" while the
    // portal runs it).
    if (monthly && p.status !== "active" && p.status !== "ended") continue;
    for (const market of ["ca", "us"] as Market[]) {
      const w = promoWindow(p, market);
      const starts = w.start === today;
      const ends = shiftDay(w.end, 1) === today;
      if (!starts && !ends) continue;
      const stores = PAGE_STORES.filter((s: { market: string; promoChannel: string | null }) => s.market === market
        && (monthly || (s.promoChannel !== null && (p.marketplaces ?? []).includes(s.promoChannel))));
      const members = (p.promotion_prices ?? []).filter((r) => (market === "us" ? r.in_us : r.in_ca) ?? ((market === "us" ? r.promo_price_usd : r.promo_price_cad) !== null)).map((r) => r.sku);
      if (!stores.length || !members.length) continue;
      changes.push(`${p.name ?? p.period} ${starts ? "starts" : "ended yesterday"} (${market === "ca" ? "Canada" : "USA"}, ${members.length} products, ${stores.map((s: { key: string }) => s.key).join(", ")})`);
      for (const s of stores as Array<{ key: string }>) {
        if (!due.has(s.key)) due.set(s.key, new Set());
        for (const sku of members) due.get(s.key)!.add(sku);
      }
    }
  }
  const recent = new Date(Date.now() - 6 * 3600e3).toISOString();
  const stores: Record<string, { products: number; rows: number }> = {};
  for (const [retailer, skus] of due) {
    let rows = 0;
    for (const part of chunk([...skus], 100)) {
      const filter = `retailer=eq.${retailer}&sku=${inList(part)}&url=not.is.null&verdict=in.(ok,pending)&or=(read_at.is.null,read_at.lt.${recent})`;
      const n = await countRows(filter);
      rows += n;
      if (n && !opts.dryRun) await rest(`where_to_buy_links?${filter}`, { method: "PATCH", body: JSON.stringify({ next_check_at: new Date().toISOString() }) });
    }
    stores[retailer] = { products: skus.size, rows };
  }
  if (changes.length && !opts.dryRun) console.log(`[where-to-buy] promotion day ${today}: ${changes.join("; ")}`);
  return { day: today, dryRun: Boolean(opts.dryRun), changes, stores, rows: Object.values(stores).reduce((a, s) => a + s.rows, 0) };
}

// ---------------------------------------------------------------- suggestions
// The right link, suggested (user, 2026-10-20: "1 hazlo" / "2 hazlo"). For a
// link that opens another option or product, a broken link, or a store a
// product has no link to yet, the audit looks for the product's own page at
// that store in what it already knows (the sources are described in the
// where_to_buy_suggestions migration) and OPENS each candidate before it is
// shown: a suggestion is "ready" only when its page shows the product's own
// SKU or its own store id. Using one is a person's click ("Use" — the
// product's list is saved and published as usual); a dismissed one never
// comes back. Mode "suggest" (cron every 10 minutes): the candidates are
// looked for once an hour, the waiting ones opened on every call.
// other_finish: the link opens the right listing on its default option (sku_check "listing", shown on
// the websites) — the suggestion is the address of the product's own option.
type SuggestReason = "wrong_link" | "broken_link" | "missing" | "other_finish";
type SuggestSource = "other_link" | "page_option" | "store_id";
interface Suggestion {
  id?: string; sku: string; retailer: string; url: string; found_url: string | null; reason: SuggestReason; source: SuggestSource;
  detail: string | null; current_url: string | null; status: string; status_note: string | null; hops: number; attempts: number;
  page_model: string | null; price: number | null; currency: string | null; in_stock: boolean | null;
  checked_at: string | null; next_check_at: string | null; decided_at?: string | null; updated_at?: string;
}
// Sinks Direct links follow the stores themselves, Faucetline is checked by
// hand, an eBay listing is one seller's offer of the day.
const SUGGEST_SKIP = new Set(["sinksdirect_ca", "sinksdirect_us", "faucetline", "ebay"]);
const SUGGEST_FRESH_MS = 14 * 86400e3; // readings used to find candidates
const SUGGEST_BUILD_MS = 55 * 60e3;    // candidates are looked for once an hour
// Per call: the stores the server opens itself (fast, free) and the ones
// opened through an unlocker (up to a minute a page) go in pools of their own,
// so the slow ones never hold the fast ones back.
const SUGGEST_DIRECT = { max: 40, lanes: 2 };
const SUGGEST_UNLOCKER = { max: 18, lanes: 6 };
const SUGGEST_MAX_ATTEMPTS = 6;        // opens without an answer before it fails
const SUGGEST_RETRY_HOURS = 6;         // × the attempts so far: 6 h, 12 h, … (BB&B / Overstock turn many away)
const SUGGEST_RECHECK_DAYS = 7;        // a ready suggestion is opened again after a week
const SUGGEST_FAILED_DAYS = 14;        // a failed candidate is tried again after two weeks
const SUGGEST_KEY = "where_to_buy_suggest";
const SUGGEST_COLUMNS = "id,sku,retailer,url,found_url,reason,source,detail,current_url,status,status_note,hops,attempts,page_model,price,currency,in_stock,checked_at,next_check_at,decided_at";

// The stores' own ids of the products, as the PIM keeps them — a key that
// opens the product page (Best Buy, Home Depot USA, BB&B / Overstock) or
// confirms which product a page shows (Home Depot Canada item #, Amazon.ca
// ASIN, BB&B / Overstock sub-SKU). Best Buy's comes from its offers API (the
// latest snapshot), only for an active offer. Rona's article # and Lowe's
// item # need a slug or a search to open (Rona answers 404 to the bare
// number, Lowe's search a captcha — 2026-10-20): they only confirm.
const ALIAS_STORES: Record<string, string[]> = {
  "BB&B / Overstock": ["bbb_us", "overstock_us"], "Home Depot CA": ["homedepot_ca"], "Home Depot US": ["homedepot_us"], Rona: ["rona"], "Lowe's US": ["lowes_us"],
};
interface StoreIds { bySku: Map<string, Map<string, string>>; owner: Map<string, Map<string, string>> } // retailer → sku → id / id → sku
async function loadStoreIds(): Promise<StoreIds> {
  const ids: StoreIds = { bySku: new Map(), owner: new Map() };
  const put = (retailer: string, sku: string, id: string | null | undefined) => {
    const v = String(id ?? "").trim();
    if (!v) return;
    if (!ids.bySku.has(retailer)) { ids.bySku.set(retailer, new Map()); ids.owner.set(retailer, new Map()); }
    if (!ids.bySku.get(retailer)!.has(sku)) ids.bySku.get(retailer)!.set(sku, v);
    // An id two products share names neither.
    const owner = ids.owner.get(retailer)!;
    owner.set(v, owner.has(v) && owner.get(v) !== sku ? "" : sku);
  };
  for (const a of await restAll<{ sku: string; marketplace: string; alias: string }>(`product_aliases?select=sku,marketplace,alias&marketplace=${encodeURIComponent(inList(Object.keys(ALIAS_STORES)))}`)) {
    for (const retailer of ALIAS_STORES[a.marketplace] ?? []) put(retailer, a.sku, a.alias);
  }
  for (const l of await restAll<{ sku: string; asin: string }>("amazon_links?select=sku,asin&marketplace=eq.ca&asin=not.is.null")) put("amazon_ca", l.sku, l.asin);
  const snap = await rest<Array<{ results: Array<{ sku?: string; bb_product_id?: string | null; active?: boolean }> | null }>>("channel_health?select=results&channel=eq.bestbuy&order=run_at.desc&limit=1");
  for (const o of snap[0]?.results ?? []) if (o?.sku && o.bb_product_id && o.active === true) put("bestbuy_ca", o.sku, o.bb_product_id);
  return ids;
}
const idOwner = (ids: StoreIds, retailer: string, id: string | null | undefined) => (id ? ids.owner.get(retailer)?.get(String(id)) || null : null);

// The address a store opens a product at from its id alone (tried on
// 2026-10-20: Best Buy and Home Depot USA by number; BB&B and Overstock need
// /<product id>/product.html with a path before it on Overstock — the
// category and slug can be anything; the option is chosen on the opened page).
function idAddress(retailer: string, id: string): string | null {
  const pid = id.split("-")[0];
  if (retailer === "bestbuy_ca" && /^\d{6,10}$/.test(id)) return `https://www.bestbuy.ca/en-ca/product/${id}`;
  if (retailer === "homedepot_us" && /^\d{6,12}$/.test(id)) return `https://www.homedepot.com/p/${id}`;
  if (retailer === "bbb_us" && /^\d{6,10}$/.test(pid)) return `https://www.bedbathandbeyond.com/${pid}/product.html`;
  if (retailer === "overstock_us" && /^\d{6,10}$/.test(pid)) return `https://www.overstock.com/Home-Garden/x/${pid}/product.html`;
  return null;
}

// Query parameters that choose the product on a store page; every other one
// (tracking: refccid, searchidx, redir, rtype, tid…) is left out of a suggestion.
const KEEP_PARAMS = new Set(["piid", "variant", "option"]);
function cleanSuggestionUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(asUri(u));
    if (!/^https?:$/.test(x.protocol)) return null;
    for (const k of [...x.searchParams.keys()]) if (!KEEP_PARAMS.has(k.toLowerCase())) x.searchParams.delete(k);
    x.hash = "";
    return x.href;
  } catch { return null; }
}
// Same page? (www, a trailing slash, tracking parameters and the encoding aside.)
const samePage = (a: string | null | undefined, b: string | null | undefined) => {
  const k = (u: string | null | undefined) => cleanSuggestionUrl(u)?.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/(?=\?|$)/, "").toLowerCase() ?? "";
  return Boolean(a && b) && k(a) === k(b);
};

// Words of a finish / colour name, in English: "Finition : Noir mat" and
// "Finish: Matte Black" give the same words. The option's own label
// ("Finish:", "Actual Color:") is left out.
const FR_WORDS: Record<string, string> = {
  noir: "black", mat: "matte", brosse: "brushed", poli: "polished", or: "gold", dore: "gold", blanc: "white", gris: "gray", grey: "gray",
  argent: "silver", argente: "silver", acier: "steel", inoxydable: "stainless", inox: "stainless", rouge: "red", fonce: "dark", clair: "light",
  cuivre: "copper", bronze: "bronze", graphite: "graphite", nickel: "nickel", chrome: "chrome", chrom: "chrome",
};
const NOT_COLOR = new Set(["with", "and", "et", "avec", "de", "du", "finish", "finition", "color", "colour", "couleur", "the", "a", "in", "en"]);
const colorWords = (s: string | null | undefined) => new Set(String(s ?? "")
  .replace(/(^|·)\s*[^:·]{1,30}:\s*/g, " ")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .split(/[^a-z]+/).map((w) => FR_WORDS[w] ?? w).filter((w) => w.length > 1 && !NOT_COLOR.has(w)));
// The options of a listing that best fit the product's colour and finish
// (Wayfair and Amazon name their options, never by model): the best one, or
// the two best when they tie — each is opened before it is suggested.
function optionsByName(options: OptionLink[], product: { color: string | null; finish: string | null; finish_type: string | null }): OptionLink[] {
  const want = colorWords([product.color, product.finish, product.finish_type].filter(Boolean).join(" "));
  if (!want.size) return [];
  const scored = options.map((o) => {
    const words = colorWords(o.name);
    const hits = [...words].filter((w) => want.has(w)).length;
    return { o, score: words.size ? hits / words.size : 0, hits };
  }).filter((x) => x.hits > 0 && x.score >= 0.5).sort((a, b) => b.score - a.score || b.hits - a.hits);
  if (!scored.length) return [];
  return scored.filter((x) => x.score === scored[0].score && x.hits === scored[0].hits).slice(0, 2).map((x) => x.o);
}

// The PIM product an option of a page is: by its model (the exact spelling
// between a Stylish SKU and its Azuni twin), its store id, or its UPC.
interface SuggestCtx { bySku: Map<string, string[]>; byUpc: Map<string, string>; ids: StoreIds }
const upcDigits = (v: string | null | undefined) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
function optionOwner(o: OptionLink, retailer: string, ctx: SuggestCtx): { sku: string; how: string } | null {
  if (o.model) {
    const skus = ctx.bySku.get(normSku(o.model)) ?? [];
    const exact = skus.find((s) => s.toUpperCase().replace(/\s+/g, "") === o.model!.toUpperCase().replace(/\s+/g, ""));
    if (exact || skus.length === 1) return { sku: exact ?? skus[0], how: `model ${o.model}` };
  }
  const byId = idOwner(ctx.ids, retailer, o.subSku) ?? idOwner(ctx.ids, retailer, o.itemId);
  if (byId) return { sku: byId, how: o.subSku && idOwner(ctx.ids, retailer, o.subSku) ? `sub-SKU ${o.subSku}` : `item ${o.itemId}` };
  const upc = upcDigits(o.gtin);
  if (upc.length >= 8 && ctx.byUpc.get(upc)) return { sku: ctx.byUpc.get(upc)!, how: `UPC ${o.gtin}` };
  return null;
}

interface SugLink {
  sku: string; retailer: string; url: string | null; verdict: string; sku_check: string | null; page_model: string | null;
  page_note: string | null; page_options: OptionLink[] | null; read_at: string | null; price: number | null; currency: string | null; in_stock: boolean | null;
}
interface SugProduct { sku: string; brand: string | null; color: string | null; finish: string | null; finish_type: string | null; upc: string | null; family_number: number | null }

// Look for candidates and write them (new ones wait to be opened; a link
// another product's page already showed is ready at once). `dryRun` only
// returns what it would write.
async function buildSuggestions(dryRun = false) {
  const now = new Date().toISOString();
  const [links, pimRows, products, ids, existing] = await Promise.all([
    restAll<SugLink>("where_to_buy_links?select=sku,retailer,url,verdict,sku_check,page_model,page_note,page_options,read_at,price,currency,in_stock&section=eq.where_to_buy"),
    restAll<{ sku: string; retailer: string; url: string }>("product_where_to_buy?select=sku,retailer,url"),
    restAll<SugProduct>("products?select=sku,brand,color,finish,finish_type:attributes->>finish_type,upc:attributes->>upc,family_number"),
    loadStoreIds(),
    restAll<Suggestion>(`where_to_buy_suggestions?select=${SUGGEST_COLUMNS}`),
  ]);
  const productBySku = new Map(products.map((p) => [p.sku, p]));
  const catalog = pimCatalog(products);
  const ctx: SuggestCtx = { bySku: catalog.bySku, byUpc: catalog.byUpc, ids };
  const pim = new Map(pimRows.map((r) => [`${r.sku}|${r.retailer}`, r.url]));
  const fresh = (l: SugLink) => Boolean(l.read_at) && Date.now() - Date.parse(l.read_at!) < SUGGEST_FRESH_MS;
  // The products on the Stylish pages (Azuni is never there).
  const audited = new Set(links.map((l) => l.sku).filter((s) => productBySku.has(s) && !/azuni/i.test(productBySku.get(s)?.brand ?? "")));

  // What the pages already showed: store → product → an address that shows it
  // (its own link that reads as it, or another product's link that opens it).
  // Not a page that only fell on the listing's default option.
  const shows = new Map<string, Map<string, SugLink>>();
  const note = (r: string, sku: string, l: SugLink) => {
    if (!shows.has(r)) shows.set(r, new Map());
    const prev = shows.get(r)!.get(sku);
    if (!prev || (l.read_at ?? "") > (prev.read_at ?? "")) shows.get(r)!.set(sku, l);
  };
  // Options pages list with their own address: store → product → [{ url, how, from }].
  const listed = new Map<string, Map<string, Array<{ url: string; how: string; from: string }>>>();
  for (const l of links) {
    if (!l.url || !fresh(l) || l.verdict === "broken") continue;
    if (l.sku_check === "match") note(l.retailer, l.sku, l);
    else if ((l.sku_check === "variant" || l.sku_check === "other") && l.page_model && productBySku.has(l.page_model) && !/listing's default one/.test(l.page_note ?? "")) note(l.retailer, l.page_model, l);
    for (const o of l.page_options ?? []) {
      const owner = optionOwner(o, l.retailer, ctx);
      const url = cleanSuggestionUrl(o.url);
      if (!owner || !url) continue;
      if (!listed.has(l.retailer)) listed.set(l.retailer, new Map());
      const list = listed.get(l.retailer)!.get(owner.sku) ?? [];
      if (!list.some((x) => x.url === url)) list.push({ url, how: owner.how, from: l.sku });
      listed.get(l.retailer)!.set(owner.sku, list);
    }
  }
  // The audit's verdict on each product's current link (both sites carry it).
  const current = new Map<string, SugLink>();
  for (const l of links) {
    if (!l.url || pim.get(`${l.sku}|${l.retailer}`) !== l.url) continue;
    const k = `${l.sku}|${l.retailer}`;
    const prev = current.get(k);
    if (!prev || (l.read_at ?? "") > (prev.read_at ?? "")) current.set(k, l);
  }

  const storeName = (k: string) => wtbRetailer(k)?.label ?? k;
  const candidates: Suggestion[] = [];
  const needs = new Set<string>(); // sku|retailer that need a suggestion
  for (const sku of audited) {
    const product = productBySku.get(sku)!;
    for (const store of WTB_RETAILERS as Array<{ key: string }>) {
      const r = store.key;
      if (SUGGEST_SKIP.has(r)) continue;
      const cur = pim.get(`${sku}|${r}`) ?? null;
      const state = cur ? current.get(`${sku}|${r}`) : undefined;
      const reason: SuggestReason | null = !cur ? "missing"
        : state?.verdict === "broken" ? "broken_link"
        : state && (state.sku_check === "variant" || state.sku_check === "other") ? "wrong_link"
        : state?.sku_check === "listing" ? "other_finish" : null;
      if (!reason) continue;
      const found: Suggestion[] = [];
      const add = (url: string | null, source: SuggestSource, detail: string, ready?: SugLink) => {
        const clean = cleanSuggestionUrl(url);
        if (!clean || samePage(clean, cur) || found.some((f) => samePage(f.url, clean))) return;
        // Wayfair addresses need the listing's sku; a cut one cannot open.
        if ((r === "wayfair_ca" || r === "wayfair_us") && !WAYFAIR_SKU_RE.test(clean)) return;
        found.push({
          sku, retailer: r, url: clean, found_url: clean, reason, source, detail, current_url: cur, status: ready ? "ready" : "to_check", status_note: null, hops: 0, attempts: 0,
          page_model: ready?.page_model ?? null, price: ready ? ready.price : null, currency: ready?.currency ?? null, in_stock: ready?.in_stock ?? null,
          checked_at: ready?.read_at ?? null, next_check_at: ready ? new Date(Date.now() + SUGGEST_RECHECK_DAYS * 86400e3).toISOString() : now,
        });
      };
      // 1. An address at this store whose page showed this product.
      const seen = shows.get(r)?.get(sku);
      if (seen?.url) add(seen.url, "other_link", seen.sku === sku ? `${storeName(r)} showed ${sku} on this page` : `${seen.sku}'s ${storeName(r)} link opens ${sku}'s page`, seen);
      // 2. A page that lists it as an option, with its own address.
      for (const x of listed.get(r)?.get(sku) ?? []) add(x.url, "page_option", `The ${storeName(r)} page of ${x.from}'s link lists ${sku} as an option (${x.how})`);
      // 3. The store's own id of the product.
      const id = ids.bySku.get(r)?.get(sku);
      const byId = id ? idAddress(r, id) : null;
      if (byId && !(cur && cur.includes(id!.split("-")[0]))) add(byId, "store_id", r === "bestbuy_ca" ? `Best Buy's offers API: product ${id}` : r === "homedepot_us" ? `Home Depot USA id ${id} (Aliases)` : `BB&B / Overstock id ${id} (Aliases)`);
      // 4. The listing the wrong link opens: its option named like this product's finish.
      if ((reason === "wrong_link" || reason === "other_finish") && state?.page_options?.length) {
        const unowned = state.page_options.filter((o) => !optionOwner(o, r, ctx));
        for (const o of optionsByName(unowned, product)) add(o.url, "page_option", `The page of the link names an option "${o.name}" (${[product.color, product.finish].filter(Boolean).join(" / ")})`);
      }
      if (found.length) { needs.add(`${sku}|${r}`); candidates.push(...found.slice(0, 3)); }
      else if (cur) needs.add(`${sku}|${r}`); // still wrong or broken: a suggestion found before stays
    }
  }

  // Reconcile with what is stored — by the address a suggestion was found at
  // (it may since have moved to its option's or the store's own address).
  const key = (s: { sku: string; retailer: string; url: string; found_url?: string | null }) => `${s.sku}|${s.retailer}|${s.found_url ?? s.url}`;
  const stored = new Map<string, Suggestion>();
  for (const s of existing) { stored.set(key(s), s); stored.set(`${s.sku}|${s.retailer}|${s.url}`, s); }
  const inserts: Suggestion[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  for (const c of candidates) {
    const ex = stored.get(key(c));
    if (!ex) { inserts.push(c); continue; }
    if (ex.status === "dismissed" || ex.status === "applied") continue;
    if (ex.status === "failed") {
      if (ex.checked_at && Date.now() - Date.parse(ex.checked_at) > SUGGEST_FAILED_DAYS * 86400e3) {
        patches.push({ id: ex.id!, patch: { status: "to_check", attempts: 0, hops: 0, status_note: null, next_check_at: now, reason: c.reason, current_url: c.current_url, updated_at: now } });
      }
      continue;
    }
    if (ex.reason !== c.reason || ex.current_url !== c.current_url || ex.detail !== c.detail) {
      patches.push({ id: ex.id!, patch: { reason: c.reason, current_url: c.current_url, detail: c.detail, updated_at: now } });
    }
  }
  // A waiting or ready suggestion whose link is now fine, or is now its
  // address: used (the link is its address) or no longer needed.
  const stale: string[] = [];
  for (const ex of existing) {
    if (ex.status !== "to_check" && ex.status !== "ready") continue;
    const cur = pim.get(`${ex.sku}|${ex.retailer}`);
    if (cur && samePage(cur, ex.url)) patches.push({ id: ex.id!, patch: { status: "applied", decided_at: ex.decided_at ?? now, updated_at: now } });
    else if (!needs.has(`${ex.sku}|${ex.retailer}`)) stale.push(ex.id!);
  }
  if (dryRun) {
    const tally: Record<string, number> = {};
    for (const c of inserts) tally[`${c.retailer} · ${c.reason} · ${c.source}${c.status === "ready" ? " (ready)" : ""}`] = (tally[`${c.retailer} · ${c.reason} · ${c.source}${c.status === "ready" ? " (ready)" : ""}`] ?? 0) + 1;
    return {
      dryRun: true, candidates: candidates.length, wouldAdd: inserts.length, wouldUpdate: patches.length, wouldRemove: stale.length, tally,
      sample: inserts.slice(0, 80).map((c) => `${c.sku} ${c.retailer} ${c.reason} ${c.source}${c.status === "ready" ? " READY" : ""}: ${c.url} — ${c.detail}`),
    };
  }
  for (const part of chunk(inserts, 300)) {
    await rest("where_to_buy_suggestions?on_conflict=sku,retailer,url", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(part) });
  }
  for (const part of chunk(patches, 6)) await Promise.all(part.map((p) => rest(`where_to_buy_suggestions?id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify(p.patch) })));
  for (const part of chunk(stale, 100)) await rest(`where_to_buy_suggestions?id=in.(${part.join(",")})`, { method: "DELETE" });
  const bySource: Record<string, number> = {};
  for (const c of inserts) bySource[`${c.source}${c.status === "ready" ? " (ready)" : ""}`] = (bySource[`${c.source}${c.status === "ready" ? " (ready)" : ""}`] ?? 0) + 1;
  return { candidates: candidates.length, added: inserts.length, updated: patches.length, removed: stale.length, bySource };
}

// Open the waiting suggestions (and the ready ones due a second look): a page
// that shows the product's own SKU or store id makes it ready; a page that
// lists it as an option sends the suggestion to that option's address once.
async function verifySuggestions(deadline: number) {
  const nowIso = new Date().toISOString();
  const dueFilter = `select=${SUGGEST_COLUMNS}&status=in.(to_check,ready)&next_check_at=lte.${nowIso}&order=status.desc,next_check_at.asc`;
  const slow = inList(UNLOCKER_RETAILERS);
  const [fastDue, slowDue] = await Promise.all([
    rest<Suggestion[]>(`where_to_buy_suggestions?${dueFilter}&retailer=not.${slow}&limit=${SUGGEST_DIRECT.max}`),
    rest<Suggestion[]>(`where_to_buy_suggestions?${dueFilter}&retailer=${slow}&limit=${SUGGEST_UNLOCKER.max}`),
  ]);
  const due = [...fastDue, ...slowDue];
  if (!due.length) return { opened: 0, ready: 0, failed: 0, moved: 0, waiting: 0 };
  // Claimed for 15 minutes (an overlapping call skips them).
  await rest(`where_to_buy_suggestions?id=in.(${due.map((s) => s.id).join(",")})`, { method: "PATCH", body: JSON.stringify({ next_check_at: at(LEASE_MIN * 60e3) }) });
  if (due.some((s) => routeFor(s.retailer, "").includes("scraperapi"))) await refreshScraperCredits();
  const [products, ids] = await Promise.all([
    restAll<{ sku: string; upc: string | null; family_number: number | null }>("products?select=sku,upc:attributes->>upc,family_number"),
    loadStoreIds(),
  ]);
  const catalog = pimCatalog(products);
  const ctx: SuggestCtx = { bySku: catalog.bySku, byUpc: catalog.byUpc, ids };
  const counts = { opened: 0, ready: 0, failed: 0, moved: 0, waiting: 0 };
  const now = () => new Date().toISOString();
  const patch = (s: Suggestion, p: Record<string, unknown>) => rest(`where_to_buy_suggestions?id=eq.${s.id}`, { method: "PATCH", body: JSON.stringify({ ...p, updated_at: now() }) });
  const fail = (s: Suggestion, why: string) => { counts.failed += 1; return patch(s, { status: "failed", status_note: why.slice(0, 300), checked_at: now(), next_check_at: null }); };
  // Give a suggestion another address (its option's, or the store's own
  // address of the product). When that address is a suggestion of its own
  // already, this one is set aside — it stays as failed, so it is not found
  // again every hour.
  const moveTo = async (s: Suggestion, url: string, p: Record<string, unknown>) => {
    const twin = await rest<Array<{ id: string }>>(`where_to_buy_suggestions?select=id&sku=eq.${encodeURIComponent(s.sku)}&retailer=eq.${s.retailer}&url=eq.${encodeURIComponent(url)}&id=neq.${s.id}`);
    if (twin.length) { await fail(s, "Same page as another suggestion"); return false; }
    await patch(s, { ...p, url, found_url: s.found_url ?? s.url });
    return true;
  };
  const lane = async (queue: Suggestion[]) => {
    while (queue.length && Date.now() + 15000 < deadline) {
      const s = queue.shift()!;
      // Menards and Lowe's open only through their scraper (minutes per
      // batch): the scraper itself read the options it lists (Menards gives a
      // record per finish), so such a suggestion counts as seen; any other
      // cannot be opened here.
      if (SCRAPERS[s.retailer]) {
        if (s.source !== "page_option") { await fail(s, `${SCRAPERS[s.retailer].label} opens only through its scraper batch`); continue; }
        counts.ready += 1;
        await patch(s, { status: "ready", status_note: `Read by Bright Data's ${SCRAPERS[s.retailer].label} scraper`, checked_at: now(), next_check_at: new Date(Date.now() + 365 * 86400e3).toISOString() });
        continue;
      }
      let host = "";
      try { host = new URL(s.url).hostname.toLowerCase(); } catch { await fail(s, "Not a valid web address"); continue; }
      const row: DueRow = { id: s.id!, sku: s.sku, url: s.url, host, retailer: s.retailer, verdict: "pending", note: null, fail_count: 0, signal_count: 0, signal_at: null, job_id: null, job_at: null };
      const o = await checkRow(row, deadline);
      counts.opened += o.kind === "later" ? 0 : 1;
      if (o.kind === "later") { await patch(s, { next_check_at: at(5 * 60e3) }); continue; }
      if (o.kind === "none") {
        const attempts = s.attempts + 1;
        if (attempts >= SUGGEST_MAX_ATTEMPTS) await fail(s, `No service could open the page (${o.note ?? "no answer"})`);
        else { counts.waiting += 1; await patch(s, { attempts, status_note: `Not opened yet — ${o.note ?? "no answer"}`, next_check_at: at(SUGGEST_RETRY_HOURS * attempts * 3600e3) }); }
        continue;
      }
      if (o.kind === "broken") { await fail(s, o.note ?? "The page does not exist"); continue; }
      const page = o.page ?? null;
      if (o.kind !== "ok" || !page) { await fail(s, o.note ?? "The page does not show the product"); continue; }
      if (page.gone) { await fail(s, page.note ?? "The store no longer sells it"); continue; }
      const check = skuCheck(page, s.sku, catalog);
      const ownId = ids.bySku.get(s.retailer)?.get(s.sku);
      const byOwnId = Boolean(ownId) && [page.subSku, page.itemId].some((v) => v && String(v) === ownId);
      if (check?.check === "match" || byOwnId) {
        // An address built from an id becomes the store's own address of the
        // product (its canonical, with the option the page was opened on).
        let url = s.url;
        if (s.source === "store_id" && page.canonical) {
          try {
            const c = new URL(page.canonical);
            const opened = new URL(s.url);
            if (c.hostname.replace(/^www\./, "") === opened.hostname.replace(/^www\./, "")) {
              for (const k of KEEP_PARAMS) if (opened.searchParams.get(k)) c.searchParams.set(k, opened.searchParams.get(k)!);
              url = cleanSuggestionUrl(c.href) ?? s.url;
            }
          } catch { /* keep the opened address */ }
        }
        const reading = {
          status: "ready", status_note: byOwnId && check?.check !== "match" ? `The page shows its ${s.retailer === "bbb_us" || s.retailer === "overstock_us" ? "sub-SKU" : "store id"} ${ownId}` : null,
          page_model: check?.model ?? page.ids[0] ?? null, price: page.price, currency: page.currency, in_stock: page.inStock,
          checked_at: now(), next_check_at: new Date(Date.now() + SUGGEST_RECHECK_DAYS * 86400e3).toISOString(), attempts: 0,
        };
        if (url === s.url) await patch(s, reading);
        else if (!(await moveTo(s, url, reading))) continue;
        counts.ready += 1;
        continue;
      }
      // The page lists the product as one of its options: that option's address, once.
      const option = s.hops < 1 ? page.optionLinks.find((x) => optionOwner(x, s.retailer, ctx)?.sku === s.sku) : undefined;
      const optionUrl = cleanSuggestionUrl(option?.url);
      if (option && optionUrl && !samePage(optionUrl, s.url)) {
        if (await moveTo(s, optionUrl, { hops: s.hops + 1, attempts: 0, status: "to_check", status_note: null, next_check_at: now() })) counts.moved += 1;
        continue;
      }
      await fail(s, check?.check === "unknown" && !check.model ? "The page names no model the PIM can match" : `The page shows ${check?.model ?? page.ids[0] ?? "another product"}, not ${s.sku}`);
    }
  };
  await Promise.all([
    ...Array.from({ length: SUGGEST_DIRECT.lanes }, () => lane(fastDue)),
    ...Array.from({ length: SUGGEST_UNLOCKER.lanes }, () => lane(slowDue)),
  ]);
  // Claimed but not reached this call: due again now.
  const left = [...fastDue, ...slowDue].map((s) => s.id);
  if (left.length) await rest(`where_to_buy_suggestions?id=in.(${left.join(",")})`, { method: "PATCH", body: JSON.stringify({ next_check_at: new Date().toISOString() }) });
  return counts;
}

async function suggest(opts: { build?: boolean; dryRun?: boolean } = {}) {
  const started = Date.now();
  const deadline = started + BATCH_MS;
  if (opts.dryRun) return { built: await buildSuggestions(true), verified: null, ms: Date.now() - started };
  const state = (await rest<Array<{ value: { built_at?: string } }>>(`app_settings?select=value&key=eq.${SUGGEST_KEY}`))[0]?.value ?? {};
  const build = opts.build || !state.built_at || Date.now() - Date.parse(state.built_at) > SUGGEST_BUILD_MS;
  const built = build ? await buildSuggestions() : null;
  if (build) {
    await rest("app_settings?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: SUGGEST_KEY, value: { built_at: new Date().toISOString(), last: built }, updated_at: new Date().toISOString() }) });
  }
  const verified = await verifySuggestions(deadline);
  return { built, verified, ms: Date.now() - started };
}

// After a product's list is saved: its suggestions whose address is now the
// link were used.
async function settleSuggestions(skus: string[], pim: PimLinks) {
  try {
    const open = await rest<Array<{ id: string; sku: string; retailer: string; url: string }>>(`where_to_buy_suggestions?select=id,sku,retailer,url&sku=${inList(skus)}&status=in.(to_check,ready)`);
    const used = open.filter((s) => (pim.links.get(s.sku) ?? []).some((l) => l.retailer === s.retailer && samePage(l.url, s.url))).map((s) => s.id);
    if (used.length) await rest(`where_to_buy_suggestions?id=in.(${used.join(",")})`, { method: "PATCH", body: JSON.stringify({ status: "applied", decided_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  } catch (e) { console.warn("[where-to-buy] suggestions not settled:", (e as Error).message); }
}

async function status() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/where_to_buy_links?select=id&${dueFilter()}`, {
    method: "HEAD", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact" },
  });
  const due = Number(r.headers.get("content-range")?.split("/")[1] ?? 0);
  const state = await readScanState();
  return { due, scannedAt: state.scanned_at ?? null, differs: state.differs ?? {}, publishQueue: (await readQueue()).length };
}

// Cron chain: the cron call (every 10 minutes) passes chain: 0; each batch
// that still has due links fires the next one (fire-and-forget) until
// nothing is due or MAX_CHAIN batches ran — a chain cut short (a deploy, a
// runtime limit) is picked up by the next cron call. Overlapping chains skip each other's claimed links.
function chainNext(chain: number) {
  if (!CRON_SECRET || chain >= MAX_CHAIN) return;
  const p = fetch(`${SUPABASE_URL}/functions/v1/where-to-buy-audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET },
    body: JSON.stringify({ mode: "check", chain: chain + 1 }),
  }).then((r) => r.body?.cancel()).catch((e) => console.warn("[where-to-buy] chain failed:", (e as Error).message));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}

// ---------------------------------------------------------------- price2spy
// Same page? Compare host (no www) + path (no trailing slash, lower-case);
// when paths differ, the same numeric id (6+ digits), ASIN, or Wix product slug
// on the same host also counts (retailers rewrite the slug part of the URL).
function urlKeyParts(u: string): { host: string; path: string; id: string | null } | null {
  try {
    const x = new URL(u.replace(/ /g, "%20"));
    const host = x.hostname.toLowerCase().replace(/^www\./, "");
    const path = x.pathname.toLowerCase().replace(/\/+$/, "");
    // Wayfair: the product sku at the end of the path (…-tkjs5945.html) or in
    // ?redir=/?piid= identifies the listing whatever category path the link uses.
    const wayfairSku = /(?:^|\.)wayfair\.(?:ca|com)$/.test(host)
      ? (path.match(/-([a-z]{1,4}\d{4,10})(?:\.html|$)/)?.[1] ?? (x.searchParams.get("redir") ?? x.searchParams.get("piid") ?? "").toLowerCase().match(/^[a-z]{1,4}\d{4,10}$/)?.[0] ?? null)
      : null;
    const id = wayfairSku
      ?? path.match(/\/dp\/([a-z0-9]{10})(?:[/?#]|$)/)?.[1]
      ?? path.match(/\/product-page\/([^/?#]+)/)?.[1]
      ?? path.match(/(\d{6,})(?!.*\d{6,})/)?.[1]
      ?? x.searchParams.get("redir")?.toLowerCase()
      ?? null;
    return { host, path, id };
  } catch { return null; }
}

async function applyPrice2Spy(body: { rows: Array<{ sku: string; site: string; url: string; price: number | null; status: string }>; reportDate?: string | null; market?: string | null }) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new Error("No rows in the report");
  const reportDate = body.reportDate && /^\d{4}-\d{2}-\d{2}$/.test(body.reportDate) ? body.reportDate : new Date().toISOString().slice(0, 10);
  const checkedAt = `${reportDate}T12:00:00.000Z`;
  // Index the report by exact key and by host+id
  const exact = new Map<string, typeof rows[number]>();
  const byHostId = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    const k = urlKeyParts(r.url);
    if (!k) continue;
    exact.set(`${k.host}${k.path}`, r);
    if (k.id) byHostId.set(`${k.host}|${k.id}`, r);
  }
  // Candidate PIM links: every link with a URL (both sites)
  const links = await restAll<{ id: string; sku: string; url: string; verdict: string; checked_at: string | null }>(
    `where_to_buy_links?select=id,sku,url,verdict,checked_at&url=not.is.null`,
  );
  const updates = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
  let matched = 0, skippedFresh = 0;
  const counts: Record<string, number> = { ok: 0, broken: 0 };
  for (const l of links) {
    const k = urlKeyParts(l.url);
    if (!k) continue;
    const hit = exact.get(`${k.host}${k.path}`) ?? (k.id ? byHostId.get(`${k.host}|${k.id}`) : undefined);
    if (!hit) continue;
    matched += 1;
    // Keep an HTTP verdict that is newer than the report.
    if (l.verdict !== "pending" && l.checked_at && l.checked_at > checkedAt) { skippedFresh += 1; continue; }
    let verdict: "ok" | "broken";
    let note: string;
    if (hit.status === "inactive") { verdict = "broken"; note = `Price2Spy ${reportDate}: inactive URL (the page is gone)`; }
    else if (hit.status === "zero") { verdict = "ok"; note = `Price2Spy ${reportDate}: page opens, no price shown`; }
    else if (hit.status === "price") { verdict = "ok"; note = `Price2Spy ${reportDate}: price seen ${hit.price}`; }
    else continue;
    counts[verdict] += 1;
    const next = new Date(Date.parse(checkedAt) + (verdict === "ok" ? OK_HOURS : BROKEN_HOURS) * 3600e3).toISOString();
    const patch = { verdict, note, http_status: null, final_url: null, checked_at: checkedAt, checked_via: "price2spy", fail_count: 0, signal_count: 0, job_id: null, job_at: null, next_check_at: next };
    const key = JSON.stringify(patch);
    if (!updates.has(key)) updates.set(key, { patch, ids: [] });
    updates.get(key)!.ids.push(l.id);
  }
  let updated = 0;
  for (const g of updates.values()) {
    for (const ids of chunk(g.ids, 200)) {
      await rest(`where_to_buy_links?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify(g.patch) });
      updated += ids.length;
    }
  }
  return { reportDate, market: body.market ?? null, reportRows: rows.length, matched, updated, keptFresher: skippedFresh, ...counts };
}

// ---------------------------------------------------------------- price2spy xlsx (server side)
// Mirror of src/features/dashboard/lib/p2sReport.js for Deno: the matrix
// report is a plain OOXML workbook, so regex over the sheet XML is enough
// (no DOM here). Cell value + style fill + hyperlink target per cell.
import JSZip from "https://esm.sh/jszip@3.10.1";

const P2S_NOT_SITES = new Set(["product name", "map", "promo price", "targeted price", "sku", "internal id", "category", "brand", "supplier", "my own price is..."]);
const xmlAttr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
const unesc = (t: string) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const colIdx = (letters: string) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function parseP2sWorkbook(bytes: Uint8Array, fileName: string) {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (p: string) => (zip.file(p) ? await zip.file(p)!.async("string") : "");
  // shared strings
  const ss: string[] = [];
  for (const si of (await read("xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    ss.push(unesc([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("")));
  }
  // styles → fill rgb per cellXfs index
  const styles = await read("xl/styles.xml");
  const fills: (string | null)[] = [];
  for (const f of (styles.match(/<fills[^>]*>([\s\S]*?)<\/fills>/)?.[1] ?? "").matchAll(/<fill>([\s\S]*?)<\/fill>/g)) {
    const rgb = f[1].match(/<fgColor[^>]*rgb="([0-9A-Fa-f]+)"/)?.[1];
    fills.push(rgb ? rgb.slice(-6).toUpperCase() : null);
  }
  const fillOfStyle: (string | null)[] = [];
  for (const xf of (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "").matchAll(/<xf\b[^>]*>/g)) {
    fillOfStyle.push(fills[Number(xmlAttr(xf[0], "fillId") ?? 0)] ?? null);
  }
  // first sheet + its rels
  const wb = await read("xl/workbook.xml");
  const rId = wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const wbRels = await read("xl/_rels/workbook.xml.rels");
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (rId) {
    const t = wbRels.match(new RegExp(`<Relationship\\b[^>]*Id="${rId}"[^>]*Target="([^"]+)"`))?.[1] ?? wbRels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rId}"`))?.[1];
    if (t) sheetPath = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
  }
  const sheet = await read(sheetPath);
  const rels = await read(sheetPath.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"));
  const relTarget: Record<string, string> = {};
  for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = xmlAttr(r[0], "Id"); const target = xmlAttr(r[0], "Target");
    if (id && target) relTarget[id] = unesc(target);
  }
  const linkOfRef: Record<string, string> = {};
  for (const h of sheet.matchAll(/<hyperlink\b[^>]*>/g)) {
    const ref = xmlAttr(h[0], "ref"); const id = xmlAttr(h[0], "r:id");
    if (ref && id && relTarget[id]) linkOfRef[ref] = relTarget[id];
  }
  // grid
  const grid: Array<Array<{ value: string; fill: string | null; link: string | null } | undefined>> = [];
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const arr: Array<{ value: string; fill: string | null; link: string | null } | undefined> = [];
    for (const c of row[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]; const inner = c[2] ?? "";
      const ref = xmlAttr(attrs, "r") ?? ""; const m = ref.match(/^([A-Z]+)\d+$/);
      if (!m) continue;
      const type = xmlAttr(attrs, "t") ?? "";
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const value = type === "s" ? (ss[Number(v)] ?? "") : type === "inlineStr" ? unesc(inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "") : v;
      const style = Number(xmlAttr(attrs, "s") ?? -1);
      arr[colIdx(m[1])] = { value, fill: style >= 0 ? fillOfStyle[style] ?? null : null, link: linkOfRef[ref] ?? null };
    }
    grid.push(arr);
  }
  const headerIdx = grid.findIndex((r) => r.some((c) => c && c.value.trim().toLowerCase() === "product name"));
  if (headerIdx === -1) throw new Error(`${fileName}: header "Product name" not found — not a Price2Spy matrix report`);
  const headers = grid[headerIdx].map((c) => (c?.value ?? "").trim());
  const siteCols = headers.map((h, i) => ({ h, i })).filter(({ h, i }) => i > 0 && h && !P2S_NOT_SITES.has(h.toLowerCase()));
  const rows: Array<{ sku: string; site: string; url: string; price: number | null; status: string }> = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const sku = (grid[r]?.[0]?.value ?? "").trim();
    if (!sku) continue;
    for (const { h, i } of siteCols) {
      const cell = grid[r][i];
      if (!cell?.link) continue;
      const price = Number(cell.value);
      const status = cell.fill === "DFDFDF" ? "inactive" : cell.fill === "F7FAAC" || (Number.isFinite(price) && price === 0) ? "zero" : Number.isFinite(price) && price > 0 ? "price" : "unknown";
      rows.push({ sku, site: h, url: cell.link, price: Number.isFinite(price) ? price : null, status });
    }
  }
  const market = /^canada/i.test(fileName) ? "ca" : /^usa/i.test(fileName) ? "us" : null;
  const reportDate = fileName.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return { market, reportDate, sites: siteCols.map((s) => s.h), rows };
}

async function logImport(summary: string, metadata: Record<string, unknown>) {
  try {
    await rest("audit_log", { method: "POST", body: JSON.stringify({ actor_id: null, actor_email: null, actor_name: "Price2Spy (Gmail)", action: "import", entity_type: "channel", entity_id: "where_to_buy", target: "price2spy", summary, metadata }) });
  } catch (e) { console.warn("[where-to-buy] audit log failed:", (e as Error).message); }
}

// ---------------------------------------------------------------- auth
// How the caller is authorized: the cron secret, a signed-in user's JWT, or
// the Gmail script's report key (which may only post reports — the gateway
// adds an anon Authorization header, so the JWT check must really pass).
async function authKind(req: Request): Promise<"cron" | "user" | "p2s" | null> {
  if (CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET) return "cron";
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: auth } });
    if (r.ok) return "user";
  }
  if (P2S_INBOUND_SECRET && req.headers.get("x-p2s-secret") === P2S_INBOUND_SECRET) return "p2s";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const kind = await authKind(req);
    if (!kind) return json({ error: "Unauthorized" }, 401);
    if (!WIX_API_KEY) return json({ error: "Missing WIX_API_KEY secret." }, 500);
    const body = await req.json().catch(() => ({}));
    const mode = body.mode ?? "status";
    if (kind === "p2s" && mode !== "p2s-file") return json({ error: "This key may only post Price2Spy reports" }, 403);
    if (mode === "scan") {
      const now = new Date().toISOString();
      const sites = Array.isArray(body.sites) && body.sites.length ? body.sites.filter((s: string) => SITES.includes(s)) : SITES;
      const pim = await loadPimLinks();
      const sinksDirect = await refreshSinksDirect(pim, now);
      const out = [];
      for (const s of sites) out.push(await scanSite(s, now, pim));
      // The PIM owns the section: pages whose Sinks Direct link changed, and
      // pages that show something else than the PIM, are written again.
      await enqueuePublish([...new Set([...sinksDirect.changed, ...out.flatMap((o) => [...o.differsFromPim, ...o.newlyLinked])])]);
      const prev = await readScanState();
      await writeScanState({
        scanned_at: now,
        standard: { ...(prev.standard ?? {}), ...Object.fromEntries(out.map((o) => [o.site, o.standardPortals])) },
        differs: { ...(prev.differs ?? {}), ...Object.fromEntries(out.map((o) => [o.site, o.differsFromPim])) },
      });
      return json({ ok: true, scanned_at: now, sinksDirect: sinksDirect.counts, sites: out.map(({ differsFromPim, ...o }) => ({ ...o, differsFromPim: differsFromPim.length })) });
    }
    if (mode === "sync") {
      // body: { skus } — a product's links were saved in the PIM.
      const skus = Array.isArray(body.skus) ? body.skus.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 50) : [];
      if (!skus.length) return json({ error: "skus[] is required" }, 400);
      const rebuilt = await syncSkus(skus);
      const published = await publishSkus(skus, Date.now() + 60000);
      await enqueuePublish(published.filter((r) => r.status === "later").map((r) => r.sku));
      // Check the new addresses now, in the background (a broken one then
      // leaves the pages through the queue).
      const p = check({ skus, dueOnly: true }).catch((e) => console.warn("[where-to-buy] sync check failed:", (e as Error).message));
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(p);
      return json({ ok: true, rebuilt, published });
    }
    if (mode === "promo-reread") return json({ ok: true, ...(await promoReread({ asOf: body.asOf, dryRun: body.dryRun === true })) });
    if (mode === "suggest") return json({ ok: true, ...(await suggest({ build: body.build === true, dryRun: body.dryRun === true })) });
    // The publish queue on its own (cron every 5 minutes): a check call that
    // spends its whole budget on pages leaves no time to write the Stylish
    // pages (the queue barely moved on 2026-10-20 once the checks ran 20 pages
    // at a time).
    if (mode === "publish") return json({ ok: true, published: await drainPublishQueue(Date.now() + BATCH_MS) });
    if (mode === "p2s") return json({ ok: true, ...(await applyPrice2Spy(body)) });
    if (mode === "p2s-file") {
      // body: { files: [{ name, base64 }] } (or a single { name, base64 })
      const files: Array<{ name: string; base64: string }> = Array.isArray(body.files) ? body.files : body.name && body.base64 ? [{ name: body.name, base64: body.base64 }] : [];
      if (!files.length) return json({ error: "files[] with { name, base64 } is required" }, 400);
      const results = [];
      for (const f of files) {
        try {
          const bytes = Uint8Array.from(atob(String(f.base64).replace(/\s+/g, "")), (c) => c.charCodeAt(0));
          const parsed = await parseP2sWorkbook(bytes, String(f.name ?? ""));
          const r = await applyPrice2Spy({ rows: parsed.rows, reportDate: parsed.reportDate, market: parsed.market });
          await logImport(`Price2Spy report ${f.name}: ${r.matched} links matched, ${r.ok} ok, ${r.broken} broken`, { ...r, file: f.name, via: "gmail" });
          results.push({ file: f.name, ...r });
        } catch (e) {
          results.push({ file: f.name, error: (e as Error).message });
        }
      }
      return json({ ok: true, results });
    }
    if (mode === "check") {
      const skus = Array.isArray(body.skus) ? body.skus.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 20) : undefined;
      const result = await check({ limit: body.limit, skus });
      if (typeof body.chain === "number" && result.morePending && result.checked > 0) chainNext(body.chain);
      return json({ ok: true, chain: body.chain ?? null, ...result });
    }
    return json({ ok: true, ...(await status()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[where-to-buy-audit] FAILED:", message);
    return json({ error: message }, 500);
  }
});
