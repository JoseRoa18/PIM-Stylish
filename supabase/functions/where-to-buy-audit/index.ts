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
//                (user, 2026-10-19): an OK link every 2 days, a broken one
//                daily, a link without an answer after a few hours
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
// Auth: `x-cron-secret` (cron) or a signed-in user's JWT. Deployed with
// --no-verify-jwt so the cron call (no JWT) reaches the handler.

import { resolveWixSite } from "../_shared/wixSites.ts";
import { WTB_RETAILERS, wtbRetailer, cleanWtbUrl, linksToShow, withWhereToBuySection } from "../_shared/whereToBuy.js";

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
const OK_HOURS = 48;        // an OK link is re-checked every 2 days (user, 2026-10-19)
const BROKEN_HOURS = 20;    // a broken one daily — also the gap between two soft signals
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
//   Bright Data opens Wayfair, Home Depot CA / USA, Best Buy, Amazon.ca,
//   Lowe's (7/8) and Rona (ScraperAPI never does); Menards only in async
//   mode from a US exit. ScraperAPI opens BB&B and Overstock (Akamai turns
//   Bright Data away, 1-2 of 5) and eBay. Amazon usually lets the server in.
// Anything not listed: the server's probe, then one Bright Data try.
type Method = "direct" | "brightdata" | "scraperapi" | "menards";
const ROUTES: Record<string, Method[]> = {
  wayfair_us: ["brightdata", "scraperapi"],
  wayfair_ca: ["brightdata", "scraperapi"],
  homedepot_ca: ["brightdata", "scraperapi"],
  homedepot_us: ["brightdata", "scraperapi"],
  bestbuy_ca: ["brightdata", "scraperapi"],
  lowes_us: ["brightdata", "scraperapi"],
  lowes_ca: ["brightdata", "scraperapi"],
  rona: ["brightdata"],
  menards: ["menards"],
  bbb_us: ["scraperapi", "brightdata"],
  overstock_us: ["scraperapi", "brightdata"],
  ebay: ["scraperapi", "brightdata"],
  amazon_ca: ["direct", "brightdata", "scraperapi"],
  amazon_us: ["direct", "brightdata", "scraperapi"],
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
interface Row {
  site: string; sku: string; wix_product_id: string | null; section: string; market: string | null;
  retailer: string; label: string | null; url: string | null; host: string | null;
  retailer_id: string | null; expected_id: string | null; verdict: string;
  http_status: number | null; final_url: string | null; note: string | null;
  scanned_at: string; checked_at: string | null;
  next_check_at: string | null; checked_via: string | null; fail_count: number; signal_count: number;
  job_id: string | null; job_at: string | null;
}
// The checker's state on a link, carried over by URL when a scan rebuilds the rows.
type LinkState = Pick<Row, "verdict" | "http_status" | "final_url" | "note" | "checked_at" | "next_check_at" | "checked_via" | "fail_count" | "signal_count" | "job_id" | "job_at">;
const STATE_COLUMNS = "url,verdict,http_status,final_url,note,checked_at,next_check_at,checked_via,fail_count,signal_count,job_id,job_at";
type Base = { site: string; sku: string; wix_product_id: string | null; scanned_at: string };
type Link = { retailer: string; url: string };
interface PimLinks { skus: Set<string>; links: Map<string, Link[]> }

// The PIM's own list (product_where_to_buy) — the source of every Stylish
// page's WHERE TO BUY section since 2026-10-19.
async function loadPimLinks(skus?: string[]): Promise<PimLinks> {
  const only = skus?.length ? `&sku=${inList(skus)}` : "";
  const products = await restAll<{ sku: string }>(`products?select=sku${only}`);
  const links = new Map<string, Link[]>();
  for (const r of await restAll<{ sku: string } & Link>(`product_where_to_buy?select=sku,retailer,url${only}`)) {
    if (!links.has(r.sku)) links.set(r.sku, []);
    links.get(r.sku)!.push({ retailer: r.retailer, url: r.url });
  }
  return { skus: new Set(products.map((p) => p.sku)), links };
}

// The checker's state of the links, by URL — from either site, as both
// pages carry the same address: ok / broken verdicts it reached in the last
// KEEP_DAYS, and every pending link's retries, soft signals and Menards job.
async function priorState(skus?: string[]) {
  const since = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString();
  const prior = new Map<string, LinkState>();
  const only = skus?.length ? `&sku=${inList(skus)}` : "";
  for (const r of await restAll<{ url: string } & LinkState>(
    `where_to_buy_links?select=${STATE_COLUMNS}&url=not.is.null${only}&or=(verdict.eq.pending,and(verdict.in.(ok,broken),checked_via.not.is.null,checked_at.gte.${since}))`,
  )) {
    // A verdict beats "pending"; between two of a kind, the newer answer.
    const prev = prior.get(r.url);
    const better = !prev || (prev.verdict === "pending" && r.verdict !== "pending")
      || ((prev.verdict === "pending") === (r.verdict === "pending") && (r.checked_at ?? "") > (prev.checked_at ?? ""));
    if (better) prior.set(r.url, r);
  }
  return prior;
}

// One row per store link of a page. Decided without opening it: an address
// that is not a URL, or a Wayfair link cut before the sku, cannot open; a
// site no service opens is checked by hand. Everything else starts pending
// (or carries the checker's state) and the checker decides.
function linkRows(base: Base, links: Link[], prior: Map<string, LinkState>): Row[] {
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
    const carried = verdict === "pending" ? prior.get(l.url) : undefined;
    const fresh: LinkState = {
      verdict, http_status: null, final_url: null, note, checked_at: null,
      next_check_at: verdict === "pending" ? null : NEVER, checked_via: null,
      fail_count: 0, signal_count: 0, job_id: null, job_at: null,
    };
    const { url: _u, ...state } = (carried ?? fresh) as LinkState & { url?: string };
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
      next_check_at: null, checked_via: null, fail_count: 0, signal_count: 0, job_id: null, job_at: null,
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

  const rows: Row[] = [];
  const counts = { products: 0, links: 0, broken: 0, missing: 0, notInPim: 0, differsFromPim: [] as string[], standardPortals: [] as string[] };
  const perProduct: Array<{ base: Base; links: Link[] }> = [];
  const seenSku = new Set<string>();
  for (const { p, sku } of withSku) {
    // Only the PIM's products are audited (user, 2026-10-19): a Wix page
    // whose SKU the PIM does not have (spare parts like RSH-K107B, old
    // listings) is left out. A SKU listed twice on Wix (B-122NG) counts once.
    if (!pim.skus.has(sku)) { counts.notInPim += 1; continue; }
    if (seenSku.has(sku)) continue;
    seenSku.add(sku);
    counts.products += 1;
    const wtb = (p.additionalInfoSections ?? []).find((s) => /where\s*to\s*buy/i.test(s.title ?? ""));
    const live = liveLinks(wtb?.description ?? "");
    const base: Base = { site: siteKey, sku, wix_product_id: p.id ?? null, scanned_at: now };
    // Checked from the PIM's list; the live section is compared with it
    // (a hand edit in Wix shows up as a difference).
    const links = pim.links.get(sku) ?? [];
    const lr = linkRows(base, links, prior);
    // What the page should show: the list without its broken links.
    const shown = lr.filter((r) => r.verdict !== "broken").map((r) => ({ retailer: r.retailer, url: r.url as string }));
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
  return out;
}

// ---------------------------------------------------------------- check
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
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
    const r = await fetch(url.replace(/ /g, "%20"), { headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: ctrl.signal });
    const status = r.status;
    const finalUrl = r.url || url;
    let body = "";
    if (DOC_HOST.test(new URL(finalUrl).hostname)) { try { await r.body?.cancel(); } catch { /* ignore */ } }
    else { try { body = (await r.text()).slice(0, 1500000); } catch { body = ""; } }
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
// every link of the product's list but the broken ones (user, 2026-10-20: a
// broken link stays in the PIM to be fixed but leaves the website, and comes
// back when it answers again). Only that section changes — the rest of the
// page is read from Wix and sent back as it is. Pages to (re)write wait in a
// queue (app_settings.where_to_buy_publish_queue) that every check call
// drains a little at a time: Wix lets ~30 changes through, then asks to wait.
const QUEUE_KEY = "where_to_buy_publish_queue";
const WIX_BASE = "https://www.wixapis.com";
const PUBLISH_MAX = 20; // product pages written per call

type PublishStatus = "published" | "up_to_date" | "no_links" | "not_linked" | "not_found" | "error" | "later";
interface PublishResult { sku: string; site: string; status: PublishStatus; error?: string }

async function brokenUrls(skus: string[]): Promise<Set<string>> {
  const rows: Array<{ url: string }> = [];
  for (const part of chunk(skus, 100)) rows.push(...await restAll<{ url: string }>(`where_to_buy_links?select=url&verdict=eq.broken&url=not.is.null&sku=${inList(part)}`));
  return new Set(rows.map((r) => r.url));
}

async function publishSkus(skus: string[], deadline: number, maxPushes = PUBLISH_MAX): Promise<PublishResult[]> {
  if (!skus.length) return [];
  const [pim, broken, wix, products] = await Promise.all([
    loadPimLinks(skus),
    brokenUrls(skus),
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
        const next = withWhereToBuySection(sections, linksToShow(all, broken), siteKey, { owned: all.length > 0 });
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
interface Outcome { kind: Kind; via?: Method; status?: number | null; note?: string | null; finalUrl?: string | null; jobId?: string }

const METHOD_LABEL: Record<Method, string> = { direct: "Direct", brightdata: "Bright Data", scraperapi: "ScraperAPI", menards: "Bright Data (Menards)" };
// Time an attempt may take, so a call never starts one it cannot finish.
const METHOD_MS: Record<Method, number> = { direct: 14000, brightdata: 67000, scraperapi: 72000, menards: 35000 };

const pageTitle = (html: string) => decode((html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
const PAGE_NOT_FOUND_TITLE = /not found|introuvable|no longer available|isn.t available|couldn.t find|\b404\b|page unavailable/i;
// Not-found pages whose title says nothing (checked 2026-10-19):
// Home Depot USA, Menards ("SORRY!"), Lowe's.
const PAGE_NOT_FOUND_BODY = /The product you are trying to view is not currently available|The page you are looking for can not be found|404 File Not Found/i;
const PAGE_BLOCKED_TITLE = /access denied|pardon our interruption|are you a human|just a moment|attention required|robot check|captcha|security check|request unsuccessful/i;
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
// category page instead is a soft sign; a bot page is no answer at all.
function judgePage(status: number | null, body: string, sku: string, via: Method): Outcome {
  const title = pageTitle(body);
  if (status === 404 || status === 410) return { kind: "broken", via, status, note: `HTTP ${status}` };
  if (PAGE_NOT_FOUND_TITLE.test(title) || PAGE_NOT_FOUND_BODY.test(body)) return { kind: "broken", via, status, note: "The page says the product was not found" };
  if (PAGE_BLOCKED_TITLE.test(title)) return { kind: "none", via, status, note: `bot check page ("${title.slice(0, 40)}")` };
  if (status !== null && status >= 200 && status < 300 && title && showsProduct(title, body, sku)) return { kind: "ok", via, status, note: null };
  if (status !== null && status >= 200 && status < 300 && title) return { kind: "soft", via, status, note: `Opens a page without the product: "${title.slice(0, 80)}"` };
  return { kind: "none", via, status, note: status ? `HTTP ${status}, empty page` : "no page" };
}

// Bright Data turns a burst away ("Your account exceeded the allowed rate
// limits" on 611 links of the first full pass, 2026-10-19): at most 10 pages
// at a time per call, and after a rate-limit answer every lane waits 20 s.
// A link the limit turned away is tried again soon, not counted as a failure.
const brightData = { inFlight: 0, coolUntil: 0 };
const BD_MAX_IN_FLIGHT = 10;
const RATE_LIMIT_RE = /rate limit/i;
async function viaBrightData(url: string, sku: string, deadline: number): Promise<Outcome> {
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
      body: JSON.stringify({ zone: BRIGHTDATA_ZONE, url: url.replace(/ /g, "%20"), format: "json" }),
      signal: AbortSignal.timeout(65000),
    });
    if (r.status === 429) { brightData.coolUntil = Date.now() + 20000; return { kind: "later", via: "brightdata" }; }
    if (!r.ok) return { kind: "none", via: "brightdata", note: `HTTP ${r.status} from the service` };
    const j = await r.json() as { status_code?: number; headers?: Record<string, string>; body?: string };
    const code = j.status_code ?? null;
    if (RATE_LIMIT_RE.test(j.headers?.["x-brd-error"] ?? "")) { brightData.coolUntil = Date.now() + 20000; return { kind: "later", via: "brightdata" }; }
    // 5xx / 403 / 429 here are the store or the unlocker turning the page down.
    if (code === null || code >= 500 || code === 403 || code === 429) return { kind: "none", via: "brightdata", status: code, note: j.headers?.["x-brd-error"] ?? `HTTP ${code}` };
    return judgePage(code, j.body ?? "", sku, "brightdata");
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
async function viaScraperApi(url: string, sku: string): Promise<Outcome> {
  if (scraperApi.credits < 25) return { kind: "none", via: "scraperapi", note: SCRAPERAPI_KEY ? "no credits left this month" : "not configured" };
  while (scraperApi.inFlight >= 4) await new Promise((ok) => setTimeout(ok, 500));
  scraperApi.inFlight += 1;
  scraperApi.credits -= 10;
  try {
    const r = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(url.replace(/ /g, "%20"))}`, { signal: AbortSignal.timeout(70000) });
    const body = await r.text();
    if (r.status === 404 || r.status === 410) return { kind: "broken", via: "scraperapi", status: r.status, note: `HTTP ${r.status}` };
    if (r.status >= 400) return { kind: "none", via: "scraperapi", status: r.status, note: r.status === 500 ? "could not open the page" : `HTTP ${r.status}` };
    return judgePage(r.status, body, sku, "scraperapi");
  } catch (e) {
    return { kind: "none", via: "scraperapi", note: (e as Error).name === "TimeoutError" ? "no answer in 70 s" : (e as Error).message.slice(0, 80) };
  } finally { scraperApi.inFlight -= 1; }
}

// Menards (Imperva + hCaptcha) opens only through Bright Data's async mode
// from a US exit, after several minutes. A live page comes back with the
// product; a dead one makes the unlocker retry until it gives up — Menards
// sends a missing product to its error page, which reads as a block — so
// "gave up" is a soft sign (S-611W and B-101C, both "SORRY!" pages, did it).
async function viaMenards(row: DueRow): Promise<Outcome> {
  if (!BRIGHTDATA_API_TOKEN) return { kind: "none", via: "menards", note: "not configured" };
  const auth = { Authorization: `Bearer ${BRIGHTDATA_API_TOKEN}` };
  try {
    if (row.job_id) {
      const g = await fetch(`https://api.brightdata.com/unblocker/get_result?response_id=${encodeURIComponent(row.job_id)}`, { headers: auth, signal: AbortSignal.timeout(30000) });
      if (g.status === 202) {
        const hours = (Date.now() - Date.parse(row.job_at ?? "")) / 3600e3;
        return hours >= JOB_GIVEUP_HOURS
          ? { kind: "soft", via: "menards", note: `Menards gave no answer in ${JOB_GIVEUP_HOURS} h` }
          : { kind: "waiting", via: "menards" };
      }
      const body = await g.text();
      if (g.status >= 400 && g.status !== 404) return { kind: "none", via: "menards", note: `HTTP ${g.status} from the service` };
      if (g.status === 404 || /^\s*\{\s*"status_code"\s*:\s*5\d\d/.test(body)) {
        return { kind: "soft", via: "menards", note: "Menards did not show the page (a missing product goes to Menards' error page)" };
      }
      return judgePage(Number(g.headers.get("x-brd-status-code") ?? g.status), body, row.sku, "menards");
    }
    const r = await fetch(`https://api.brightdata.com/unblocker/req?zone=${encodeURIComponent(BRIGHTDATA_ZONE)}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ url: row.url.replace(/ /g, "%20"), country: "us" }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    const id = j.response_id ?? r.headers.get("x-response-id");
    return id ? { kind: "submitted", via: "menards", jobId: id } : { kind: "none", via: "menards", note: `job not accepted (HTTP ${r.status})` };
  } catch (e) {
    return { kind: "none", via: "menards", note: (e as Error).message.slice(0, 80) };
  }
}

// One link: its route's methods in order until one answers. The server's own
// probe keeps its finer rules (redirects to home / login pages).
async function checkRow(row: DueRow, deadline: number): Promise<Outcome> {
  const misses: string[] = [];
  let last: Outcome = { kind: "none", note: "not tried" };
  for (const m of routeFor(row.retailer, row.host ?? "")) {
    if (Date.now() + METHOD_MS[m] > deadline) return misses.length ? { kind: "none", note: misses.join(" · ") } : { kind: "later" };
    let o: Outcome;
    if (m === "direct") {
      const p = await probe(row.url);
      o = { kind: p.verdict === "pending" ? "none" : p.verdict, via: "direct", status: p.http_status, finalUrl: p.final_url, note: p.note };
      // An open page counts only when it shows the product (user, 2026-10-19):
      // Walmart and Amazon sometimes answer a bot check that looks like a
      // normal page ("Robot or human?", "Verify Your Identity", Amazon's
      // captcha titled "Amazon.ca") — then the next service of the route tries.
      // Only there: a small store's page may not name the brand ("BAMBOO
      // CUTTING BOARD – Cabinet Depot") and is not a bot page.
      if (o.kind === "ok" && p.body !== undefined && BOT_PRONE.has(row.retailer) && !showsProduct(p.title ?? "", p.body, row.sku)) {
        o = { kind: "none", via: "direct", status: p.http_status, note: `the page does not show the product ("${(p.title ?? "").slice(0, 50)}")` };
      }
    } else if (m === "brightdata") o = await viaBrightData(row.url, row.sku, deadline);
    else if (m === "scraperapi") o = await viaScraperApi(row.url, row.sku);
    else o = await viaMenards(row);
    if (o.kind !== "none") return o;
    misses.push(`${METHOD_LABEL[m]}: ${o.note ?? "no answer"}`);
    last = o;
  }
  return { ...last, note: misses.join(" · ") };
}

// ---------------------------------------------------------------- check
interface DueRow { id: string; sku: string; url: string; host: string | null; retailer: string; verdict: string; note: string | null; fail_count: number; signal_count: number; job_id: string | null; job_at: string | null }
const DUE_COLUMNS = "id,sku,url,host,retailer,verdict,note,fail_count,signal_count,job_id,job_at";

const at = (ms: number) => new Date(Date.now() + ms).toISOString();

// How many soft signs make a link Broken, and how far apart. Menards needs
// 4 tries 6 h apart: its unlocker also gives up on some LIVE pages (B-108G
// opened in the user's browser on 2026-10-20 after a "gave up"), while a dead
// one fails every time.
const SOFT_RULE: Record<string, { strikes: number; everyHours: number }> = {
  menards: { strikes: 4, everyHours: 6 },
  default: { strikes: 2, everyHours: BROKEN_HOURS },
};

// What an outcome writes on the row.
function patchFor(row: DueRow, o: Outcome, now: string): Record<string, unknown> | null {
  const clearJob = { job_id: null, job_at: null };
  const verdictPatch = (verdict: "ok" | "broken", note: string | null, signals: number) => ({
    verdict, note, http_status: o.status ?? null, final_url: verdict === "broken" ? o.finalUrl ?? null : null,
    checked_at: now, checked_via: o.via === "menards" ? "brightdata" : o.via ?? null,
    fail_count: 0, signal_count: signals, ...clearJob,
    next_check_at: at((verdict === "ok" ? OK_HOURS : BROKEN_HOURS) * 3600e3),
  });
  switch (o.kind) {
    case "ok": return verdictPatch("ok", null, 0);
    case "broken": return verdictPatch("broken", o.note ?? null, 0);
    case "soft": {
      const signals = row.signal_count + 1;
      const rule = SOFT_RULE[row.retailer] ?? SOFT_RULE.default;
      if (signals >= rule.strikes) return verdictPatch("broken", `${o.note} — on ${rule.strikes} checks over a day`, signals);
      // Not enough yet: keep the verdict, look again later.
      return {
        signal_count: signals, fail_count: 0, ...clearJob, next_check_at: at(rule.everyHours * 3600e3),
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
      ...(row.verdict === "pending" ? { note: "Opening through Menards (takes a few minutes)" } : {}),
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
// stores read through an unlocker (one call opens ~20 of them; links never
// verified first), and the links the server opens itself (fast, free).
const UNLOCKER_RETAILERS = Object.entries(ROUTES).filter(([, r]) => r[0] !== "direct").map(([k]) => k);
const UNLOCKER_BATCH = 48;
const DIRECT_BATCH = 250;

async function check(opts: { limit?: number; skus?: string[]; dueOnly?: boolean } = {}) {
  const started = Date.now();
  const deadline = started + BATCH_MS;
  const rows = opts.skus?.length
    ? await rest<DueRow[]>(`where_to_buy_links?select=${DUE_COLUMNS}&sku=${inList(opts.skus)}&${opts.dueOnly ? dueFilter() : "url=not.is.null&verdict=not.in.(missing,manual)"}`, { headers: { Prefer: "count=none" } })
    : [
      ...await rest<DueRow[]>(`where_to_buy_links?select=${DUE_COLUMNS}&${dueFilter()}&retailer=${inList(UNLOCKER_RETAILERS)}&order=verdict.desc,next_check_at.asc.nullsfirst&limit=${UNLOCKER_BATCH}`, { headers: { Prefer: "count=none" } }),
      ...await rest<DueRow[]>(`where_to_buy_links?select=${DUE_COLUMNS}&${dueFilter()}&retailer=not.${inList(UNLOCKER_RETAILERS)}&order=next_check_at.asc.nullsfirst&limit=${opts.limit ?? DIRECT_BATCH}`, { headers: { Prefer: "count=none" } }),
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
  const byHost = new Map<string, DueRow[]>();
  for (const r of leads) { const h = (r.host ?? "").replace(/^www\./, ""); if (!byHost.has(h)) byHost.set(h, []); byHost.get(h)!.push(r); }
  const answers: Array<{ row: DueRow; o: Outcome }> = [];
  await Promise.all([...byHost.entries()].map(async ([host, list]) => {
    const unlocker = !routeFor(list[0].retailer, host).every((m) => m === "direct");
    const { pace, lanes } = unlocker ? { pace: 500, lanes: 2 } : laneConfig(host);
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
  }));
  const results = answers.flatMap(({ row, o }) => sameUrl.get(row.url)!.map((r) => ({ row: r, o })));

  const now = new Date().toISOString();
  const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
  const republish = new Set<string>();
  for (const { row, o } of results) {
    const patch = patchFor(row, o, now);
    if (!patch) continue;
    if (typeof patch.verdict === "string" && (patch.verdict === "broken") !== (row.verdict === "broken")) republish.add(row.sku);
    const key = JSON.stringify(patch);
    if (!groups.has(key)) groups.set(key, { patch, ids: [] });
    groups.get(key)!.ids.push(row.id);
  }
  for (const g of groups.values()) {
    for (const ids of chunk(g.ids, 200)) await rest(`where_to_buy_links?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify(g.patch) });
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
  const morePending = !opts.skus?.length && (untouched.length > 0 || rows.length >= UNLOCKER_BATCH);
  return {
    published,
    checked: results.filter((r) => r.o.kind !== "later").length, addresses: answers.length, morePending, byKind, byVia,
    scraperCredits: scraperApi.credits, ms: Date.now() - started,
    ...(opts.skus?.length ? { links: answers.map(({ row, o }) => ({ sku: row.sku, retailer: row.retailer, url: row.url, kind: o.kind, via: o.via ?? null, note: o.note ?? null })) } : {}),
  };
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
      await enqueuePublish([...new Set([...sinksDirect.changed, ...out.flatMap((o) => o.differsFromPim)])]);
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
