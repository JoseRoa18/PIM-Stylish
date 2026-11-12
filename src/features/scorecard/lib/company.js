import { BOARDS, MARKET_LABEL } from './boards';

// The Company tab of the EOS ScoreCard (user, 2026-11-11: "un total / top
// view de toda la empresa", seen only by its viewers). It adds up what the
// marketplace tabs already hold — nothing is measured twice:
//   MAP        the average of every marketplace's MAP % ("el average de todos
//              los MK %"), company-wide and per country;
//   Sales      each marketplace's weekly sales, the country's total, its
//              target and the total against it. Canada in CAD, the USA in
//              USD — never added together;
//   Shipping   the average of every marketplace's on-time shipping %;
//   Inventory  units available and the share of products with stock per
//              country, from the database's hourly snapshot.
// A new company row is one more entry in buildCompanyView.
//
// Targets (user, 2026-11-12: "que permita hacer cambios para los goal"). One
// target per number: a marketplace's row carries the target of its own tab's
// row (`metric`: changed here or there, by an admin); a row the tab works out
// itself keeps its target on the tab (`target`: { key, own, born } — `born`
// is the one it has before anyone sets one, "Total vs target" at least 100%).
// A country's total is given no target: it takes its marketplaces' targets
// added up ("debería llenarse automáticamente al sumar el target de todos los
// marketplaces") — the ones that have one; its tooltip names those that do
// not (the user's USA list had none for Menards: "con ese debes hacer lo
// mismo").

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
 * @param {object[]} metrics  the marketplace rows with a COMPANY_AUTO_KEYS key ({ id, board, market, name, unit, auto_key, goal, goal_op })
 * @param {Map}      values   their values, keyed `${metric_id}|${week}` (listValues)
 * @param {object[]} own      scorecard_company_values rows ({ key, week_start, value, origin, updated_at }), every week up to the last shown
 * @param {object[]} targets  scorecard_company_targets rows ({ key, goal, goal_op, updated_at })
 * @param {string[]} weeks    the shown columns (Sundays)
 * @returns {{ groups: { key, label, rows }[], values: Map }}
 */
export function buildCompanyView({ metrics, values, own, targets = [], weeks }) {
  const out = new Map();
  // A row the tab works out, with its target: the one set here, else the one it is born with.
  const targetOf = new Map(targets.map((t) => [t.key, t]));
  const withTarget = (row, born = null) => {
    const set = targetOf.get(row.id);
    const from = set ?? born;
    return { ...row, goal: from ? Number(from.goal) : null, goal_op: from?.goal_op ?? null, target: { key: row.id, own: Boolean(set), born } };
  };
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
    return scopes.map((s) => withTarget({ id: s.id, name: s.name, unit: 'percent', auto_key: COMPANY_KEY, strong: s.strong, hint: `${hint} (${s.list.length} marketplace tabs)` }));
  };

  // ---- sales: each marketplace, the country's total against its target ----
  const salesGroup = (mk) => {
    const list = rowsOf('sales', mk).sort((a, b) => (boardOrder.get(a.board) ?? 99) - (boardOrder.get(b.board) ?? 99));
    // a marketplace's row is its own tab's row: the same numbers, the same target
    const rows = list.map((m) => ({ id: `sales:${mk}:${m.board}`, name: boardLabel(m.board), unit: 'money', goal: m.goal ?? null, goal_op: m.goal == null ? null : m.goal_op ?? null, auto_key: COMPANY_KEY, metric: m, hint: `${boardLabel(m.board)} ${MARKET_LABEL[mk]} — Sales, from its own tab (its target too)` }));
    // the country's target: its marketplaces' targets added up (the ones that have one: a sales floor)
    const withOne = list.filter((m) => m.goal != null && (m.goal_op === '>=' || m.goal_op === '>'));
    const without = list.filter((m) => !withOne.includes(m)).map((m) => boardLabel(m.board));
    const target = withOne.length ? withOne.reduce((a, m) => a + Number(m.goal), 0) : null;
    const targetHint = !withOne.length
      ? "The marketplaces' targets added up — none of them has a target yet"
      : without.length
        ? `The targets of ${withOne.length} of the ${list.length} marketplaces above, added up — no target yet: ${without.join(', ')}`
        : `The targets of the ${list.length} marketplaces above, added up`;
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
      if (total != null && target > 0) put(`sales_vs_target:${mk}`, w, total / target, cells);
    }
    return [
      ...rows,
      { id: `sales_total:${mk}`, name: `Total ${MARKET_LABEL[mk]}`, unit: 'money', goal: target, goal_op: target == null ? null : '>=', auto_key: COMPANY_KEY, strong: true, targetHint, hint: `The marketplaces above, added up (${CURRENCY[mk]}). Target: ${targetHint.charAt(0).toLowerCase()}${targetHint.slice(1)}.` },
      withTarget({ id: `sales_vs_target:${mk}`, name: 'Total vs target', unit: 'percent', auto_key: COMPANY_KEY, hint: "The total ÷ its target (the marketplaces' targets added up)" }, { goal: 1, goal_op: '>=' }),
    ];
  };

  // ---- inventory: the database's hourly snapshot per country ----
  const stockRows = MARKETS.flatMap((mk) => [
    withTarget({ id: `inv_units:${mk}`, name: `${MARKET_LABEL[mk]} — units available`, unit: 'number', auto_key: COMPANY_KEY, hint: `Units available for use in ${MARKET_LABEL[mk]}'s warehouse (Odoo), every product added up` }),
    withTarget({ id: `inv_in_stock:${mk}`, name: `${MARKET_LABEL[mk]} — products in stock`, unit: 'percent', auto_key: COMPANY_KEY, hint: `Share of the products Odoo tracks in ${MARKET_LABEL[mk]} that have stock` }),
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
