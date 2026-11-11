// Price Alignment's report of one target and the expected prices behind it:
// the same code for the app (Pricing, the Dashboard card, the exports) and the
// server (the EOS ScoreCard's MAP %, user 2026-11-09), so the two can never read
// different numbers. Re-used through createPriceAlignment: `db` is a Supabase
// client, `sharedLoad(key, loader)` shares a read between the targets of one
// view, and `readingsOfOneStore` reads a store's page readings alone (a run of
// the server is about one tab, the app shows them all).
import { etToday, promoWindow, windowContains, periodOfDay, prevPeriod, shiftDay, PROMO_DATE_COLUMNS } from './promoCalendar.ts';
import { PAGE_STORES } from './pageStores.js';
import { NLP_MIN_DISCOUNT, NLP_CATEGORIES, nlpDiscount } from './homeDepotCaNlp.js';
import { priceOff } from './priceTolerance.js';

// The brand rule of a Wix store (wixSiteSells in the app, siteSells on the server).
function siteSellsBrand(cfg, brand) {
  const b = String(brand ?? '').toLowerCase();
  if (cfg.onlyBrands?.length) return cfg.onlyBrands.some((x) => b.includes(x));
  return !(cfg.excludedBrands ?? []).some((x) => b.includes(x));
}

// Everything the alignment can point at: the Wix sites, Best Buy, the two
// Walmarts and the stores read from their pages.
export const alignTargets = (WIX_SITES) => ({
  ...Object.fromEntries(
    Object.entries(WIX_SITES).map(([key, cfg]) => [key, { ...cfg, kind: 'wix', canFix: true, promoChannel: `wix_${key}` }]),
  ),
  bestbuy: {
    key: 'bestbuy',
    kind: 'bestbuy',
    canFix: true,
    channel: 'bestbuy',
    label: 'Best Buy Canada',
    short: 'Best Buy',
    symbol: 'C$',
    priceField: 'map_cad',
    priceShort: 'MAP (CAD)',
    promoAware: true,
    market: 'ca',
    promoChannel: 'bestbuy',
  },
  walmart_us: {
    key: 'walmart_us',
    kind: 'walmart',
    canFix: false,
    channel: 'walmart_us',
    label: 'Walmart US',
    short: 'Walmart US',
    symbol: '$',
    priceField: 'map_usd',
    priceShort: 'MAP (USD)',
    promoAware: true,
    market: 'us',
    promoChannel: 'walmart_us',
  },
  // Walmart Canada exposes prices only while a promotion exists on the SKU
  // (the promo read carries the regular price next to it), so the analysis
  // covers promo compliance; SKUs without any price on file are left out.
  walmart_ca: {
    key: 'walmart_ca',
    kind: 'walmart',
    canFix: false,
    channel: 'walmart_ca',
    label: 'Walmart Canada',
    short: 'Walmart CA',
    symbol: 'C$',
    priceField: 'map_cad',
    priceShort: 'MAP (CAD)',
    promoAware: true,
    market: 'ca',
    promoChannel: 'walmart_ca',
  },
  ...Object.fromEntries(PAGE_STORES.map((s) => [s.key, {
    ...s,
    kind: 'page',
    canFix: false,
    retailer: s.key,
    symbol: s.market === 'us' ? '$' : 'C$',
    priceField: s.market === 'us' ? 'map_usd' : 'map_cad',
    priceShort: s.market === 'us' ? 'MAP (USD)' : 'MAP (CAD)',
    promoAware: true,
  }])),
});

export function createPriceAlignment({ db, sharedLoad, readingsOfOneStore = false }) {
  // The kinds that run on their own dates on the marketplaces picked for them.
  const DEAL_KINDS = ['flash', 'mk_event', 'special'];

  // The day a flash deal / special event reaches the store. BB&B and Overstock
  // switch at ~10-11 PM of the start date (`dealStartsAtNight` in pageStores.js),
  // so their deal is expected from the next day: the pages read on the start
  // date still show the price before it (user, 2026-11-09: Black Friday's start
  // date took their scores to 66 and 64 with every page right).
  const dealLiveDay = (cfg, w) => (cfg.dealStartsAtNight ? shiftDay(w.start, 1) : w.start);

  /**
   * What every product SHOULD sell at on a target, read from the PIM right
   * now: the target's regular price field, and the market's active monthly
   * promo price for members when the target follows promotions. Reading it
   * live means a price edited in the PIM shows in the report at once, without
   * pulling the channel again (the pull only refreshes the LIVE prices).
   * `today` (an Eastern day, 'YYYY-MM-DD') reads another day's prices: the
   * dry runs of sinksdirect-deals. A deal's entry carries its promotion `id`.
   */
  async function loadExpectedPrices(cfg, { today = null } = {}) {
    const prods = await sharedLoad(`products:${cfg.priceField}`, async () => {
      const { data, error } = await db
        .from('products')
        .select(`sku, base:${cfg.priceField}`)
        .range(0, 4999);
      if (error) throw error;
      return data ?? [];
    });
    const baseBySku = new Map(prods.map((p) => [p.sku, p.base]));

    const promoBySku = new Map();
    if (cfg.promoAware === false) return { baseBySku, promoBySku };
    const promoField = cfg.market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
    const activePromos = await sharedLoad(`promos:${promoField}`, async () => {
      const { data, error } = await db
        .from('promotions')
        .select(`period, starts_on, ends_on, ca_starts_on, ca_ends_on, us_starts_on, us_ends_on, promotion_prices(sku, ${promoField})`)
        .eq('status', 'active')
        .eq('kind', 'monthly') // flash deals and special events are not the store's expected price
        .order('period', { ascending: true });
      if (error) throw error;
      return data ?? [];
    });
    // Market calendar: USA runs the 1st → month end; Canada runs first
    // Thursday → the day before the next first Thursday. Only the promo whose
    // window is open today sets the expected price.
    const todayET = today ?? etToday();
    for (const promo of activePromos ?? []) {
      const w = promoWindow(promo, cfg.market);
      if (!windowContains(w, todayET)) continue;
      for (const row of promo.promotion_prices ?? []) {
        // The period + window ride along so a promo fix can be pushed as a
        // SCHEDULED discount covering exactly the market window (Best Buy).
        if (row[promoField] != null) promoBySku.set(row.sku, { price: row[promoField], period: promo.period, windowStart: w.start, windowEnd: w.end, kind: 'monthly' });
      }
    }
    // A flash deal or special event running on THIS marketplace (user rule
    // 2026-10-02) is the expected price of its SKUs for as long as it runs,
    // over the monthly promo. Like the Deals overview, a deal runs by its
    // dates (flash deals stay "draft" while the portal runs them); only an
    // ended one is over early.
    if (cfg.promoChannel) {
      const deals = await sharedLoad(`deals:${cfg.promoChannel}:${promoField}`, async () => {
        const { data, error } = await db
          .from('promotions')
          .select(`id, name, kind, period, status, starts_on, ends_on, ca_starts_on, ca_ends_on, us_starts_on, us_ends_on, promotion_prices(sku, ${promoField}, in_ca, in_us)`)
          .in('kind', DEAL_KINDS)
          .neq('status', 'ended')
          .contains('marketplaces', [cfg.promoChannel]);
        if (error) throw error;
        return data ?? [];
      });
      const running = (deals ?? [])
        .map((deal) => ({ deal, w: promoWindow(deal, cfg.market) }))
        .filter(({ w }) => windowContains({ start: dealLiveDay(cfg, w), end: w.end }, todayET))
        .sort((a, b) => a.w.start.localeCompare(b.w.start)); // overlapping deals: the later start wins
      for (const { deal, w } of running) {
        // A marketplace that pins this kind to a level (BB&B and Overstock run
        // flash deals at Purple — promoChannels' levelByKind) shows the level's
        // MAP, whatever the promotion's rows carry.
        const level = cfg.levelByKind?.[deal.kind] ?? null;
        const levelMap = level ? await levelMapPrices(`map_${level}_${cfg.market === 'us' ? 'usd' : 'cad'}`) : null;
        for (const row of deal.promotion_prices ?? []) {
          // Only the deal's members in this market (the level price exists for
          // every product, so the market list is checked on its own).
          const onList = (cfg.market === 'us' ? row.in_us : row.in_ca) ?? (row[promoField] != null);
          if (!onList) continue;
          const price = levelMap ? levelMap.get(row.sku) ?? null : row[promoField];
          if (price != null) promoBySku.set(row.sku, { price, period: deal.period, windowStart: w.start, windowEnd: w.end, kind: deal.kind, name: deal.name, id: deal.id });
        }
      }
    }
    return { baseBySku, promoBySku };
  }

  /**
   * The last day, up to today, on which each product's expected price on this
   * target changed: a monthly promotion of its market started or ended for it,
   * or a flash deal / special event on this marketplace did. A store price read
   * from a page before that day says nothing about today's expected price
   * (the Where to Buy check reads a page every 3 days) — Map(sku → 'YYYY-MM-DD').
   * Monthly promotions are read back two months, ended ones included.
   */
  async function loadPriceChangeDays(cfg) {
    const promoField = cfg.market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
    const today = etToday();
    const since = prevPeriod(prevPeriod(periodOfDay(today)));
    const monthly = await sharedLoad(`promos-recent:${promoField}:${since}`, async () => {
      const { data, error } = await db
        .from('promotions')
        .select(`period, status, ${PROMO_DATE_COLUMNS}, promotion_prices(sku, ${promoField})`)
        .eq('kind', 'monthly')
        .in('status', ['active', 'ended'])
        .gte('period', since);
      if (error) throw error;
      return data ?? [];
    });
    const deals = cfg.promoChannel ? await sharedLoad(`deals-recent:${cfg.promoChannel}:${promoField}:${since}`, async () => {
      const { data, error } = await db
        .from('promotions')
        .select(`period, status, ${PROMO_DATE_COLUMNS}, promotion_prices(sku, ${promoField}, in_ca, in_us)`)
        .in('kind', DEAL_KINDS)
        .contains('marketplaces', [cfg.promoChannel])
        .gte('period', since);
      if (error) throw error;
      return data ?? [];
    }) : [];
    const changes = new Map();
    const mark = (sku, day) => { if (day <= today && (!changes.has(sku) || day > changes.get(sku))) changes.set(sku, day); };
    for (const promo of [...monthly, ...deals]) {
      const w = promoWindow(promo, cfg.market);
      for (const row of promo.promotion_prices ?? []) {
        const member = 'in_us' in row ? ((cfg.market === 'us' ? row.in_us : row.in_ca) ?? row[promoField] != null) : row[promoField] != null;
        if (!member) continue;
        mark(row.sku, deals.includes(promo) ? dealLiveDay(cfg, w) : w.start);
        mark(row.sku, shiftDay(w.end, 1));
      }
    }
    return changes;
  }

  // One MAP level column of every product (map_purple_usd…), shared.
  async function levelMapPrices(column) {
    const prods = await sharedLoad(`products:${column}`, async () => {
      const { data, error } = await db.from('products').select(`sku, level:${column}`).range(0, 4999);
      if (error) throw error;
      return data ?? [];
    });
    return new Map(prods.map((p) => [p.sku, p.level]));
  }

  // The latest snapshot of a channel (run_at + per-SKU results), shared.
  function latestChannelSnapshot(channel) {
    return sharedLoad(`snapshot:${channel}`, async () => {
      const { data, error } = await db
        .from('channel_health')
        .select('run_at, results')
        .eq('channel', channel)
        .order('run_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      return data ?? [];
    });
  }

  const eq = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.01;

  function classifySnapshot(snapshot, outOfScope = null) {
    const counts = { promo_ok: 0, map_ok: 0, promo_missing: 0, misaligned: 0, no_map: 0, missing: 0 };
    const problems = [];
    // The products found at their expected price: counted above, and listed
    // so one product can be looked up on every store (the assistant).
    const aligned = [];
    let total = 0;
    let notOnStore = 0;
    let legacy = false;

    for (const r of snapshot.results ?? []) {
      if (r.state === 'not_in_pim') continue; // Wix orphans — out of scope
      if (outOfScope?.has(r.sku)) continue; // brand the store never carries
      // Rule (user, 2026-09-23): a product the store does not carry is not a
      // price problem — it stays out of the report and its score.
      if (r.state === 'missing') { notOnStore += 1; continue; }
      // An uncounted row (BB&B / Overstock: read sold out or SKU not confirmed)
      // is listed with the problems when it is one, but counts nowhere.
      const counted = !r.uncounted;
      const tally = (key) => { if (counted) counts[key] += 1; };
      if (counted) total += 1;
      // Snapshots older than the expected-price rollout can't be classified.
      if (!('expected' in r)) { legacy = true; continue; }
      // A price read from the store's page carries where and when it was read.
      const page = r.url ? { url: r.url, read_at: r.read_at ?? null, unconfirmed: r.sku_check !== 'match', in_stock: r.in_stock ?? null, page_note: r.page_note ?? null } : {};

      if (r.expected == null) {
        tally('no_map');
        problems.push({ sku: r.sku, status: 'no_map', live: r.price ?? null, expected: null, source: null, ...page });
      } else if (!r.price_diff) {
        tally(r.expected_source === 'promo' ? 'promo_ok' : 'map_ok');
        aligned.push({ sku: r.sku, live: r.price ?? null, expected: r.expected, source: r.expected_source, promo_kind: r.promo_kind ?? null, ...page });
      } else if (r.expected_source === 'promo' && (r.no_promo || eq(r.price, r.map))) {
        tally('promo_missing');
        problems.push({ sku: r.sku, status: 'promo_missing', live: r.price ?? null, expected: r.expected, source: 'promo', map: r.map ?? null, promo_period: r.promo_period ?? null, promo_kind: r.promo_kind ?? null, promo_window: r.promo_window ?? null, ...page });
      } else {
        tally('misaligned');
        problems.push({ sku: r.sku, status: 'misaligned', live: r.price, expected: r.expected, source: r.expected_source, map: r.map ?? null, promo_period: r.promo_period ?? null, promo_kind: r.promo_kind ?? null, promo_window: r.promo_window ?? null, ...page });
      }
    }

    problems.sort((a, b) => a.sku.localeCompare(b.sku));
    return { ranAt: snapshot.run_at, total, counts, problems, aligned, legacy, notOnStore };
  }

  /**
   * Best Buy / Walmart snapshots are raw channel data (sku, price, …), so the
   * expected price is joined in here: the market's active promo price for
   * members, the site's regular MAP for everyone else. Rows whose SKU isn't in
   * the PIM are out of scope (source-of-truth rule), mirroring the Wix orphan
   * handling.
   */
  async function loadOfferAlignment(cfg, task = null) {
    task?.progress(0, `Reading the latest ${cfg.short} report…`);
    const data = await latestChannelSnapshot(cfg.channel);
    if (!data?.length) return null;
    const snapshot = data[0];
    task?.progress(0.4, 'Reading the expected prices…');
    const { baseBySku, promoBySku } = await loadExpectedPrices(cfg);
    task?.progress(0.9, 'Comparing the prices…');

    // Mirakl keeps the promo as a discount next to the regular price: the live
    // selling price is the discount while its window is open, and a discount
    // scheduled for the promo month already counts as the promo being in place.
    const today = etToday();
    const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : null);
    const livePrice = (o, promo) => {
      if (o.discount_price == null) return o.price ?? null;
      const start = day(o.discount_start);
      const end = day(o.discount_end);
      const active = (!start || start <= today) && (!end || end >= today);
      if (active) return o.discount_price;
      const scheduledForPromo = promo && (!start || start <= promo.windowStart) && (!end || end >= promo.windowStart)
        && Math.abs(o.discount_price - promo.price) < 0.01;
      return scheduledForPromo ? o.discount_price : (o.price ?? null);
    };

    const results = [];
    for (const o of snapshot.results ?? []) {
      if (!baseBySku.has(o.sku)) continue; // channel SKU not in the PIM
      const base = baseBySku.get(o.sku) ?? null;
      const promo = promoBySku.get(o.sku);
      // No price on file: Walmart CA shows prices only through a promo. A SKU
      // that should be on promo and was read with none is a missing promo;
      // any other has no price to compare and stays out.
      const noPromo = o.price == null && o.discount_price == null;
      if (noPromo && !(promo && o.promo_checked_at)) continue;
      const expected = promo?.price ?? base;
      const price = noPromo ? null : livePrice(o, promo);
      results.push({
        sku: o.sku,
        state: 'live',
        price,
        expected: expected ?? null,
        expected_source: promo != null ? 'promo' : 'map',
        map: base,
        promo_period: promo?.period ?? null,
        promo_kind: promo?.kind ?? null,
        promo_window: promo ? { start: promo.windowStart, end: promo.windowEnd } : null,
        no_promo: noPromo,
        price_diff: noPromo || priceOff(price, expected),
      });
    }
    return classifySnapshot({ run_at: snapshot.run_at, results });
  }

  // Every store link's last reading, read ONCE for all the page targets of a
  // view and kept 5 minutes (a reading changes every few hours at most; the
  // database is small — a Dashboard visit must not fire one read per store):
  // the view where_to_buy_readings gives one row per store and product, the
  // links already read and the broken ones (not on the store). The pages past
  // the first 1,000 rows are read at the same time.
  const PAGE_RETAILERS = PAGE_STORES.map((s) => s.key);
  const READINGS_TTL_MS = 5 * 60 * 1000;
  const readings = new Map(); // 'all', or a store's key → { at, promise }
  const dropPageReadings = () => readings.clear();
  // `task` (optional taskProgress reporter) counts the pages read — only when
  // this call reads them; one that joins the shared read reports nothing.
  function pageReadings(task = null, retailer = null) {
    const cacheKey = readingsOfOneStore ? retailer : 'all';
    const hit = readings.get(cacheKey);
    if (hit && Date.now() - hit.at < READINGS_TTL_MS) return hit.promise;
    const query = () => db
      .from('where_to_buy_readings')
      .select('sku, retailer, url, verdict, sku_check, page_model, page_note, price, currency, in_stock, read_at', { count: 'exact' })
      .in('retailer', readingsOfOneStore ? [retailer] : PAGE_RETAILERS)
      .order('retailer')
      .order('sku');
    const promise = (async () => {
      task?.progress(0, 'Reading the store prices…');
      const first = await query().range(0, 999);
      if (first.error) throw first.error;
      const total = Math.max(1, Math.ceil((first.count ?? 0) / 1000));
      let read = 1;
      const counted = (p) => { read += 1; task?.count(read, total, `Reading the store prices · ${read} of ${total} pages`); return p; };
      task?.count(read, total, `Reading the store prices · ${read} of ${total} pages`);
      const rest = [];
      for (let from = 1000; from < (first.count ?? 0); from += 1000) rest.push(task ? query().range(from, from + 999).then(counted) : query().range(from, from + 999));
      const pages = await Promise.all(rest);
      for (const p of pages) if (p.error) throw p.error;
      return [first, ...pages].flatMap((p) => p.data ?? []);
    })();
    readings.set(cacheKey, { at: Date.now(), promise });
    promise.catch(() => { if (readings.get(cacheKey)?.promise === promise) readings.delete(cacheKey); });
    return promise;
  }

  // Every product's category, shared (Home Depot Canada's NLP rule).
  function productCategories() {
    return sharedLoad('products:category', async () => {
      const { data, error } = await db.from('products').select('sku, category').range(0, 4999);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.sku, p.category]));
    });
  }

  // The Eastern-time day a page was read ('YYYY-MM-DD').
  const etDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  /**
   * A store read from its own product pages: the last price the Where to Buy
   * check read on each product's link (both Stylish sites carry the same
   * link — the newest reading counts). Left out of the comparison: a broken
   * link (the product is not on the store), a page on another product or
   * option — or naming a model that is not this SKU —, a page read before the
   * product's expected price last changed (a promotion started or ended since:
   * it is read again within 3 days), a page that showed no price, and a price
   * in the other market's currency. A page that names no model at all is
   * compared but marked unconfirmed. Home Depot Canada keeps a kitchen sink at
   * MAP when its promo is under the 5% NLP minimum (the PIM's NLP workbook
   * leaves it out). On a store with `unsureUncounted` (BB&B, Overstock — user,
   * 2026-11-06) a page read sold out or with its SKU not confirmed counts in
   * no tile and no score; a price problem there is still listed.
   */
  async function loadPageAlignment(cfg, task = null) {
    const rows = (await pageReadings(task?.part(0, 0.6), cfg.retailer)).filter((r) => r.retailer === cfg.retailer);
    if (!rows.some((r) => r.read_at)) return null;
    task?.progress(0.6, 'Reading the expected prices…');
    const [{ baseBySku, promoBySku }, changedOn, categories] = await Promise.all([
      loadExpectedPrices(cfg),
      loadPriceChangeDays(cfg),
      cfg.nlpMinimum ? productCategories() : null,
    ]);
    task?.progress(0.9, 'Comparing the prices…');
    const currency = cfg.market === 'us' ? 'USD' : 'CAD';
    const bySku = new Map();
    for (const r of rows) {
      const prev = bySku.get(r.sku);
      if (!prev || (r.read_at ?? '') > (prev.read_at ?? '')) bySku.set(r.sku, r);
    }
    const results = [];
    const left = { noPrice: 0, soldOut: 0, otherProduct: 0, otherCurrency: 0, readBeforeChange: 0 };
    let readFrom = null;
    let readTo = null;
    for (const [sku, r] of bySku) {
      if (!baseBySku.has(sku)) continue; // not a PIM product
      if (r.verdict === 'broken' && r.sku_check !== 'other') { results.push({ sku, state: 'missing' }); continue; }
      // 'listing' (the right listing on its default option): the price read is the default finish's.
      if (r.sku_check === 'other' || r.sku_check === 'variant' || r.sku_check === 'listing' || (r.sku_check === 'unknown' && r.page_model)) { left.otherProduct += 1; continue; }
      if (r.price == null || !r.read_at) { left[r.in_stock === false ? 'soldOut' : 'noPrice'] += 1; continue; }
      if (r.currency && r.currency !== currency) { left.otherCurrency += 1; continue; }
      if (changedOn.has(sku) && etDay(r.read_at) < changedOn.get(sku)) { left.readBeforeChange += 1; continue; }
      if (!readFrom || r.read_at < readFrom) readFrom = r.read_at;
      if (!readTo || r.read_at > readTo) readTo = r.read_at;
      const base = baseBySku.get(sku) ?? null;
      let promo = promoBySku.get(sku);
      if (promo && categories && base != null && NLP_CATEGORIES.has(categories.get(sku)) && nlpDiscount(base, promo.price) < NLP_MIN_DISCOUNT) promo = undefined;
      const expected = promo?.price ?? base;
      results.push({
        sku,
        state: 'live',
        price: r.price,
        expected: expected ?? null,
        expected_source: promo != null ? 'promo' : 'map',
        map: base,
        promo_period: promo?.period ?? null,
        promo_kind: promo?.kind ?? null,
        promo_window: promo ? { start: promo.windowStart, end: promo.windowEnd } : null,
        price_diff: priceOff(r.price, expected),
        uncounted: Boolean(cfg.unsureUncounted && (r.in_stock === false || r.sku_check !== 'match')),
        url: r.url,
        read_at: r.read_at,
        sku_check: r.sku_check,
        in_stock: r.in_stock,
        page_note: r.page_note,
      });
    }
    return { ...classifySnapshot({ run_at: readTo, results }), readFrom, readTo, ...left };
  }

  /**
   * Latest saved report for a target (cron or manual) — instant, no live pull.
   * `task` (optional taskProgress reporter): the report, the expected prices,
   * the comparison. The reads stay shared: a call that joins one already
   * running just waits for it.
   */
  async function latestReport(cfg, { task = null } = {}) {
    if (cfg.kind === 'page') return loadPageAlignment(cfg, task);
    if (cfg.kind === 'bestbuy' || cfg.kind === 'walmart') return loadOfferAlignment(cfg, task);
    task?.progress(0, `Reading the latest ${cfg.short} report…`);
    const data = await latestChannelSnapshot(cfg.channel);
    if (!data?.length) return null;
    task?.progress(0.4);
    // Brand scope applies to older snapshots too: products of a brand the site
    // never carries are dropped before classifying (Azuni on the Stylish sites).
    let outOfScope = null;
    if (cfg.excludedBrands?.length) {
      const prods = await sharedLoad('products:brand', async () => {
        const { data, error } = await db.from('products').select('sku, brand');
        if (error) throw error;
        return data ?? [];
      });
      outOfScope = new Set(prods.filter((p) => !siteSellsBrand(cfg, p.brand)).map((p) => p.sku));
    }
    // The snapshot's expected prices are as old as the pull; the PIM's are
    // read now, so a price changed today is judged today. Live prices stay
    // as pulled.
    task?.progress(0.5, 'Reading the expected prices…');
    const { baseBySku, promoBySku } = await loadExpectedPrices(cfg);
    task?.progress(0.9, 'Comparing the prices…');
    const results = (data[0].results ?? []).map((r) => {
      if (r.state !== 'live' || !baseBySku.has(r.sku)) return r;
      const base = baseBySku.get(r.sku) ?? null;
      const promo = promoBySku.get(r.sku);
      const expected = promo?.price ?? base;
      return {
        ...r,
        expected: expected ?? null,
        expected_source: promo != null ? 'promo' : 'map',
        map: base,
        promo_period: promo?.period ?? null,
        promo_kind: promo?.kind ?? null,
        price_diff: priceOff(r.price, expected),
      };
    });
    return classifySnapshot({ run_at: data[0].run_at, results }, outOfScope);
  }

  return { loadExpectedPrices, loadPriceChangeDays, latestReport, dropPageReadings };
}
