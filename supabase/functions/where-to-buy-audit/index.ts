// "Where to Buy" audit for the Stylish brand sites (Stylish Canada / USA).
//
// mode "scan"  — reads every product of both sites through the Wix API,
//                parses the WHERE TO BUY and DOCUMENTS TO DOWNLOAD sections
//                into one row per link, flags the portals a page lacks
//                (the ones most products of the site link), and replaces the
//                site's rows (ok / broken results younger than 7 days carry
//                over by URL). Nothing is compared with the PIM: this is a
//                pure "does the link open the product page" check.
// mode "check" — probes a paced batch of pending URLs over HTTP (one lane
//                per host, ~1.2 s between requests, ~35 s budget). Pending
//                links are retried once an hour until the site answers.
//                Called hourly by cron (each call chains the next batch
//                until nothing is due) and in a loop from the UI.
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
// Only FOUR verdicts (user rule, 2026-09-15):
//   ok       the link opens and shows the product
//   broken   there is a link but it does not work: 404, "not found" page,
//            redirect to a login / home page, or an invalid address
//   missing  the page has no link to a portal that most products of the
//            site (same market) do link
//   pending  not verified yet: never probed, the site blocks robots, or it
//            did not answer — retried every hour
// The `note` column carries the reason.
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
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const P2S_INBOUND_SECRET = Deno.env.get("P2S_INBOUND_SECRET") ?? "";

const SITES = ["stylish_ca", "stylish_us"];
const KEEP_DAYS = 7;        // ok / broken results stand for a week
const RETRY_HOURS = 1;      // pending links are retried hourly
const MAX_CHAIN = 80;       // cron chain: at most 80 batches per hour
const STANDARD_SHARE = 0.6; // a portal is "standard" when 60% of the pages link it

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
}

async function scanSite(siteKey: string, now: string) {
  const site = resolveWixSite(siteKey);
  const catalog = await wixCatalog(siteKey);
  // Open Box listings (SKUs like A-802B-B-OB-A, or "Open Box" in the name)
  // are one-off clearance pages — never audited (user rule, 2026-09-15).
  const isOpenBox = (sku: string, name: string) => /-OB(-|$)/i.test(sku) || /open\s*box/i.test(name);
  const withSku = catalog
    .map((p) => ({ p, sku: skuOf(p) }))
    .filter((x): x is { p: WixProduct; sku: string } => Boolean(x.sku) && !isOpenBox(x.sku!, x.p.name ?? ""));

  // ok / broken HTTP results younger than KEEP_DAYS carry over by URL.
  const since = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString();
  const prior = new Map<string, { verdict: string; http_status: number | null; final_url: string | null; note: string | null; checked_at: string }>();
  for (const r of await restAll<{ url: string; verdict: string; http_status: number | null; final_url: string | null; note: string | null; checked_at: string }>(
    `where_to_buy_links?select=url,verdict,http_status,final_url,note,checked_at&site=eq.${siteKey}&verdict=in.(ok,broken)&http_status=not.is.null&checked_at=gte.${since}&url=not.is.null`,
  )) prior.set(r.url, r);

  const rows: Row[] = [];
  const counts = { products: withSku.length, links: 0, docs: 0, broken: 0, missing: 0, dropbox: 0, no_section: 0, standardPortals: [] as string[] };
  // Per product: which portals its section links, per market.
  const perProduct: Array<{ base: { site: string; sku: string; wix_product_id: string | null; scanned_at: string }; hasSection: boolean; present: Set<string>; markets: Set<string> }> = [];
  for (const { p, sku } of withSku) {
    const sections = p.additionalInfoSections ?? [];
    const wtb = sections.find((s) => /where\s*to\s*buy/i.test(s.title ?? ""));
    const docs = sections.find((s) => /document/i.test(s.title ?? ""));
    if (!wtb) counts.no_section += 1;
    const base = { site: siteKey, sku, wix_product_id: p.id ?? null, scanned_at: now };
    const present = new Set<string>();
    const marketsSeen = new Set<string>();

    const pushLink = (section: string, a: Anchor) => {
      let host: string | null = null;
      let parsed: URL | null = null;
      try { parsed = new URL(a.url); host = parsed.hostname.toLowerCase(); } catch { parsed = null; }
      const ret = host ? retailerFor(host) : { key: "other", market: null, label: "" };
      const market = ret.market ?? (/canada/i.test(a.heading ?? "") ? "ca" : /usa|united states/i.test(a.heading ?? "") ? "us" : null);
      // Decided at scan time (no HTTP needed): an address that is not a URL,
      // or a Wayfair link cut before the sku, cannot open. Everything else
      // starts pending and the HTTP probe decides.
      let verdict = "pending";
      let note: string | null = null;
      if (!parsed || !/^https?:$/.test(parsed.protocol) || !host) { verdict = "broken"; note = "Not a valid web address"; }
      else if ((ret.key === "wayfair_ca" || ret.key === "wayfair_us") && !WAYFAIR_SKU_RE.test(a.url)) { verdict = "broken"; note = "Cut address: Wayfair links need the product sku at the end"; }
      if (ret.key === "dropbox") counts.dropbox += 1;
      if (verdict === "broken") counts.broken += 1;
      const carried = verdict === "pending" ? prior.get(a.url) : undefined;
      rows.push({
        ...base, section, market, retailer: ret.key, label: a.label || null, url: a.url, host,
        retailer_id: null, expected_id: null,
        verdict: carried ? carried.verdict : verdict,
        http_status: carried?.http_status ?? null, final_url: carried?.final_url ?? null,
        note: carried ? carried.note : note, checked_at: carried?.checked_at ?? null,
      });
      if (section === "where_to_buy") { present.add(ret.key); if (market) marketsSeen.add(market); counts.links += 1; }
      else counts.docs += 1;
    };
    if (wtb?.description) for (const a of anchors(wtb.description)) pushLink("where_to_buy", a);
    if (docs?.description) for (const a of anchors(docs.description)) pushLink("documents", a);

    perProduct.push({ base, hasSection: Boolean(wtb), present, markets: marketsSeen });
  }

  // Missing links: the site's STANDARD portals are the retailers linked by
  // at least STANDARD_SHARE of the products that have a WHERE TO BUY
  // section (measured 2026-09-15: SinksDirect, Amazon, Wayfair, Home Depot
  // CA, Rona, Best Buy, Walmart CA on both sites). A page without one of
  // them (for a market it lists) gets a "missing" row; a page with no
  // section at all gets one per standard portal.
  const withSection = perProduct.filter((x) => x.hasSection);
  const tally = new Map<string, number>();
  for (const x of withSection) for (const k of x.present) tally.set(k, (tally.get(k) ?? 0) + 1);
  const standard = [...tally.entries()]
    .filter(([k, n]) => k !== "other" && k !== "stylish_locator" && n >= withSection.length * STANDARD_SHARE)
    .map(([k]) => k);
  counts.standardPortals = standard;
  const marketOf = (k: string) => RETAILERS.find((r) => r.key === k)?.market ?? null;
  for (const x of perProduct) {
    for (const k of standard) {
      if (x.present.has(k)) continue;
      const market = marketOf(k);
      if (x.hasSection && market && !x.markets.has(market)) continue;
      counts.missing += 1;
      rows.push({ ...x.base, section: "where_to_buy", market, retailer: k, label: null, url: null, host: null, retailer_id: null, expected_id: null, verdict: "missing", http_status: null, final_url: null, note: x.hasSection ? "No link to this portal (most products of the site have one)" : "The page has no WHERE TO BUY section", checked_at: null });
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

interface Probe { verdict: "ok" | "broken" | "pending"; http_status: number | null; final_url: string | null; note: string | null }

async function probe(url: string): Promise<Probe> {
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
    // 401/403/429 and 5xx from retailers are robot blocks (Amazon answers
    // 500/503 to datacenter traffic) — the link is not verified, try later.
    if (status === 401 || status === 403 || status === 429 || status >= 500) return { verdict: "pending", http_status: status, final_url: finalUrl, note: `Blocked by the site (HTTP ${status}), retried hourly` };
    if (BOT_RE.test(body)) return { verdict: "pending", http_status: status, final_url: finalUrl, note: "Blocked by the site (bot check page), retried hourly" };
    if (NOT_FOUND_RE.test(body)) return { verdict: "broken", http_status: status, final_url: finalUrl, note: "The page says the product was not found" };
    try {
      const a = new URL(url); const b = new URL(finalUrl);
      const rootHost = (h: string) => h.replace(/^www\./, "");
      if (rootHost(a.hostname) !== rootHost(b.hostname)) return { verdict: "broken", http_status: status, final_url: finalUrl, note: `Redirects to ${b.hostname}` };
      if (/password|login|signin/i.test(b.pathname)) return { verdict: "broken", http_status: status, final_url: finalUrl, note: "Redirects to a login / password page" };
      if ((b.pathname === "/" || b.pathname === "") && a.pathname.length > 1) return { verdict: "broken", http_status: status, final_url: finalUrl, note: "Redirects to the home page" };
    } catch { /* keep ok */ }
    if (status >= 200 && status < 400) return { verdict: "ok", http_status: status, final_url: finalUrl, note: null };
    return { verdict: "pending", http_status: status, final_url: finalUrl, note: `HTTP ${status}, retried hourly` };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "No answer in 12 s, retried hourly" : /error sending request|connection|reset|refused/i.test((e as Error).message) ? "Connection dropped by the site, retried hourly" : (e as Error).message.slice(0, 120);
    return { verdict: "pending", http_status: null, final_url: null, note: msg };
  } finally { clearTimeout(t); }
}

// Rows due for a probe: pending never probed or probed over an hour ago;
// ok / broken HTTP results older than a week (scan-time "broken" rows have
// no http_status and are never re-probed).
const dueFilter = () => {
  const retry = new Date(Date.now() - RETRY_HOURS * 3600e3).toISOString();
  const keep = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString();
  return `url=not.is.null&or=(and(verdict.eq.pending,or(checked_at.is.null,checked_at.lt.${retry})),and(verdict.in.(ok,broken),http_status.not.is.null,checked_at.lt.${keep}))`;
};

async function check(budgetMs = 35000, limit = 400) {
  const started = Date.now();
  const pending = await rest<Array<{ id: string; url: string; host: string; retailer: string }>>(
    `where_to_buy_links?select=id,url,host,retailer&${dueFilter()}&order=checked_at.asc.nullsfirst&limit=${limit}`,
    { headers: { Prefer: "count=none" } },
  );
  const byHost = new Map<string, typeof pending>();
  for (const r of pending) { const h = (r.host ?? "").replace(/^www\./, ""); if (!byHost.has(h)) byHost.set(h, []); byHost.get(h)!.push(r); }
  const results: Array<{ id: string } & Probe> = [];
  const hostStats: Record<string, { checked: number; blocked: number }> = {};
  await Promise.all([...byHost.entries()].map(async ([host, rows]) => {
    const stat = { checked: 0, blocked: 0 };
    hostStats[host] = stat;
    let blockedInARow = 0;
    const { pace, lanes } = laneConfig(host);
    let next = 0;
    const lane = async () => {
      while (next < rows.length && Date.now() - started <= budgetMs) {
        const r = rows[next++];
        let res: Probe;
        if (blockedInARow >= 3) {
          // The host is blocking this run — mark the rest pending for the
          // next hour without hitting it again.
          res = { verdict: "pending", http_status: null, final_url: null, note: "Blocked by the site, retried hourly" };
        } else {
          res = await probe(r.url);
          const blocked = res.verdict === "pending" && /Blocked/.test(res.note ?? "");
          blockedInARow = blocked ? blockedInARow + 1 : 0;
          await new Promise((ok) => setTimeout(ok, pace));
        }
        stat.checked += 1;
        if (res.verdict === "pending") stat.blocked += 1;
        results.push({ id: r.id, ...res });
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
  }));
  const now = new Date().toISOString();
  // One PATCH per distinct outcome (not per row).
  const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
  for (const r of results) {
    const patch = { verdict: r.verdict, http_status: r.http_status, final_url: r.verdict === "broken" ? r.final_url : null, note: r.note, checked_at: now };
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
  // Anything left in this batch, or a full batch, means more is due now.
  const morePending = pending.length > results.length || pending.length >= limit;
  return { checked: results.length, morePending, byVerdict, hosts: hostStats, ms: Date.now() - started };
}

async function status() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/where_to_buy_links?select=id&${dueFilter()}`, {
    method: "HEAD", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact" },
  });
  const due = Number(r.headers.get("content-range")?.split("/")[1] ?? 0);
  return { due };
}

// Cron chain: the hourly cron call passes chain: 0; each batch that still
// has due links fires the next one (fire-and-forget) until nothing is due
// or MAX_CHAIN batches ran. Blocked hosts drain fast (3 hits, then skipped).
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
    const patch = { verdict, note, http_status: null, final_url: null, checked_at: checkedAt };
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
      const out = [];
      for (const s of sites) out.push(await scanSite(s, now));
      return json({ ok: true, scanned_at: now, sites: out });
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
      const result = await check(body.budgetMs ?? 35000, body.limit ?? 400);
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
