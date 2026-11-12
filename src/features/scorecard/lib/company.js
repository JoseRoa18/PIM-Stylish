import { BOARDS, MARKET_LABEL } from './boards';

// The Company tab of the EOS ScoreCard (user, 2026-11-11: "un total / top
// view de toda la empresa", seen only by its viewers). It adds up what the
// marketplace tabs already hold — nothing is measured twice:
//   MAP        the average of every marketplace's MAP % ("el average de todos
//              los MK %"), company-wide and per country;
//   Sales      each marketplace's weekly sales, the country's total, its
//              target (typed by a viewer) and the total against it. Canada in
//              CAD, the USA in USD — never added together;
//   Shipping   the average of every marketplace's on-time shipping %;
//   Inventory  units available and the share of products with stock per
//              country, from the database's hourly snapshot.
// A new company row is one more entry in buildCompanyView.

export const COMPANY_KEY = 'company';
export const COMPANY_BOARD = { key: COMPANY_KEY, label: 'Company' };
/** The marketplace rows the tab reads (scorecard_metrics.auto_key). */
export const COMPANY_AUTO_KEYS = ['map_pct', 'sales', 'on_time_ship'];

const MARKETS = ['ca', 'us'];
const CURRENCY = { ca: 'CAD', us: 'USD' };
const average = (numbers) => (numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null);
const latest = (rows) => rows.reduce((at, r) => (r?.updated_at > (at ?? '') ? r.updated_at : at), null);

/**
 * The tab's rows and their weekly numbers, in the shape ScorecardTable takes.
 *
 * @param {object[]} metrics  the marketplace rows with a COMPANY_AUTO_KEYS key ({ id, board, market, auto_key })
 * @param {Map}      values   their values, keyed `${metric_id}|${week}` (listValues)
 * @param {object[]} own      scorecard_company_values rows ({ key, week_start, value, origin, updated_at }), every week up to the last shown
 * @param {string[]} weeks    the shown columns (Sundays)
 * @returns {{ groups: { key, label, rows }[], values: Map }}
 */
export function buildCompanyView({ metrics, values, own, weeks }) {
  const out = new Map();
  const put = (id, week, value, sources = []) => {
    if (value == null) return;
    out.set(`${id}|${week}`, { value, note: null, origin: 'auto', updated_at: latest(sources) ?? new Date().toISOString() });
  };
  const rowsOf = (key, market = null) => metrics.filter((m) => m.auto_key === key && (!market || m.market === market));
  const cellsOf = (list, week) => list.map((m) => values.get(`${m.id}|${week}`)).filter((r) => r?.value != null);
  const boardOrder = new Map(BOARDS.map((b, i) => [b.key, i]));
  const boardLabel = (key) => BOARDS.find((b) => b.key === key)?.label ?? key;

  // ---- an average of every marketplace's %: company, Canada, USA ----
  const averaged = (key, prefix, title, hint) => {
    const scopes = [
      { id: `${prefix}:all`, name: `${title} — company`, list: rowsOf(key), strong: true },
      ...MARKETS.map((mk) => ({ id: `${prefix}:${mk}`, name: `${title} — ${MARKET_LABEL[mk]}`, list: rowsOf(key, mk) })),
    ];
    for (const s of scopes) for (const w of weeks) {
      const cells = cellsOf(s.list, w);
      put(s.id, w, average(cells.map((r) => Number(r.value))), cells);
    }
    return scopes.map((s) => ({ id: s.id, name: s.name, unit: 'percent', goal: null, goal_op: null, auto_key: COMPANY_KEY, strong: s.strong, hint: `${hint} (${s.list.length} marketplace tabs)` }));
  };

  // ---- the typed numbers of the tab (a target stays in force until another is typed) ----
  const ownOf = (key) => own.filter((r) => r.key === key && r.value != null).sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
  const inForce = (list, week) => { let hit = null; for (const r of list) { if (r.week_start <= week) hit = r; else break; } return hit; };

  // ---- sales: each marketplace, the country's total, its target ----
  const salesGroup = (mk) => {
    const list = rowsOf('sales', mk).sort((a, b) => (boardOrder.get(a.board) ?? 99) - (boardOrder.get(b.board) ?? 99));
    const rows = list.map((m) => ({ id: `sales:${mk}:${m.board}`, name: boardLabel(m.board), unit: 'money', goal: null, goal_op: null, auto_key: COMPANY_KEY, hint: `${boardLabel(m.board)} ${MARKET_LABEL[mk]} — Sales, from its own tab` }));
    const targetKey = `sales_target:${mk}`;
    const targets = ownOf(targetKey);
    for (const w of weeks) {
      const cells = [];
      for (const m of list) {
        const cell = values.get(`${m.id}|${w}`);
        if (cell?.value == null) continue;
        cells.push(cell);
        out.set(`sales:${mk}:${m.board}|${w}`, cell);
      }
      const total = cells.length ? cells.reduce((a, r) => a + Number(r.value), 0) : null;
      put(`sales_total:${mk}`, w, total, cells);
      const target = inForce(targets, w);
      if (target) out.set(`${targetKey}|${w}`, { value: Number(target.value), note: null, origin: 'manual', updated_at: target.updated_at });
      if (total != null && target && Number(target.value) > 0) put(`sales_vs_target:${mk}`, w, total / Number(target.value), cells);
    }
    return [
      ...rows,
      { id: `sales_total:${mk}`, name: `Total ${MARKET_LABEL[mk]}`, unit: 'money', goal: null, goal_op: null, auto_key: COMPANY_KEY, strong: true, hint: `The marketplaces above, added up (${CURRENCY[mk]})` },
      { id: targetKey, companyKey: targetKey, name: 'Weekly target', unit: 'money', goal: null, goal_op: null, auto_key: null, editable: true, anyWeek: true, hint: `Typed by the tab's viewers (${CURRENCY[mk]}). A target stays in force until another week's is typed.` },
      { id: `sales_vs_target:${mk}`, name: 'Total vs target', unit: 'percent', goal: 1, goal_op: '>=', auto_key: COMPANY_KEY, hint: 'Total ÷ the weekly target' },
    ];
  };

  // ---- inventory: the database's hourly snapshot per country ----
  const stockRows = MARKETS.flatMap((mk) => [
    { id: `inv_units:${mk}`, name: `${MARKET_LABEL[mk]} — units available`, unit: 'number', goal: null, goal_op: null, auto_key: COMPANY_KEY, hint: `Units available for use in ${MARKET_LABEL[mk]}'s warehouse (Odoo), every product added up` },
    { id: `inv_in_stock:${mk}`, name: `${MARKET_LABEL[mk]} — products in stock`, unit: 'percent', goal: null, goal_op: null, auto_key: COMPANY_KEY, hint: `Share of the products Odoo tracks in ${MARKET_LABEL[mk]} that have stock` },
  ]);
  for (const r of own) {
    if (!r.key.startsWith('inv_') || r.value == null || !weeks.includes(r.week_start)) continue;
    out.set(`${r.key}|${r.week_start}`, { value: Number(r.value), note: null, origin: 'auto', updated_at: r.updated_at });
  }

  const groups = [
    { key: 'map', label: 'MAP alignment — average of every marketplace', rows: averaged('map_pct', 'map', 'MAP %', 'The average of the MAP % of every marketplace tab') },
    ...MARKETS.map((mk) => ({ key: `sales_${mk}`, label: `Sales — ${MARKET_LABEL[mk]} (${CURRENCY[mk]})`, rows: salesGroup(mk) })),
    { key: 'shipping', label: 'On-time shipping — average of every marketplace', rows: averaged('on_time_ship', 'on_time', 'On-time shipping', 'The average of the on-time shipping % of every marketplace tab') },
    { key: 'stock', label: 'Inventory available', rows: stockRows },
  ].filter((g) => g.rows.length);
  return { groups, values: out };
}
