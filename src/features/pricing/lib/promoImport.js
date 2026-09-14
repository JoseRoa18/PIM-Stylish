// Promotion file import: one spreadsheet per month with every promo column.
// The template is a CSV (opens in Excel) whose headers map 1:1 to the
// promotion fields; uploads accept .xlsx or .csv via the shared parser.

import { parseSpreadsheetFile } from '@/features/import/lib/parseSpreadsheet';

// header aliases (normalized: lowercase, alphanumerics only) → field
const COLUMN_SPEC = [
  { field: 'sku', header: 'SKU', aliases: ['sku', 'model', 'modelo'] },
  { field: 'promo_price_cad', header: 'PROMO MAP CAD', aliases: ['promomapcad', 'promomapcanada', 'promopricecad'] },
  { field: 'cost:rona_hd_cad', header: 'PROMO COST RONA-HOME DEPOT (CAD)', aliases: ['promocostronahomedepotcad', 'promocostronahd', 'promocostronahdcad', 'costronahomedepotcad'] },
  { field: 'cost:sod_cad', header: 'PROMO COST SMALL ONLINE DEALERS (CAD)', aliases: ['promocostsmallonlinedealerscad', 'promocostsodcad', 'costsmallonlinedealerscad'] },
  { field: 'cost:wayfair_ca_usd', header: 'PROMO COST WAYFAIR CANADA (USD)', aliases: ['promocostwayfaircanadausd', 'promocostwayfaircausd', 'costwayfaircanadausd'] },
  { field: 'promo_price_usd', header: 'PROMO MAP USD', aliases: ['promomapusd', 'promomapus', 'promopriceusd'] },
  { field: 'cost:lowes_sod_bbb_usd', header: 'PROMO COST LOWES-SOD-BBB (USD)', aliases: ['promocostlowessodbbbusd', 'promocostlowesbbbsmallonlinedealers', 'promocostlowesbbbusd', 'costlowessodbbbusd', 'promocostlowesbbbsmallonlinedealersusd'] },
  { field: 'cost:wayfair_usd', header: 'PROMO COST WAYFAIR US (USD)', aliases: ['promocostwayfairusUSD', 'promocostwayfairus', 'promocostwayfairusd', 'costwayfairususd'] },
  { field: 'cost:menards_usd', header: 'PROMO COST MENARDS (USD)', aliases: ['promocostmenardsusd', 'promocostmenards', 'costmenardsusd'] },
];

const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Each market keeps its own template — promo membership differs per market
// (August 2026: 120 Canadian SKUs vs 93 US, only 63 shared).
const TEMPLATES = {
  ca: {
    file: 'promotion-template-canada.csv',
    fields: ['sku', 'promo_price_cad', 'cost:rona_hd_cad', 'cost:sod_cad', 'cost:wayfair_ca_usd'],
    examples: [
      ['S-822H', '394', '236', '265.29', '192.24'],
      ['K-131NR', '289', '173', '194.14', '140.68'],
    ],
  },
  us: {
    file: 'promotion-template-usa.csv',
    fields: ['sku', 'promo_price_usd', 'cost:lowes_sod_bbb_usd', 'cost:wayfair_usd', 'cost:menards_usd'],
    examples: [
      ['S-822N', '263', '151', '171', '184'],
      ['K-131NR', '149', '86', '97', '104'],
    ],
  },
};

// Which parsed fields belong to each market — used to route imports and to
// sanity-check that an uploaded file matches the chosen market.
export const MARKET_FIELDS = {
  ca: TEMPLATES.ca.fields.filter((f) => f !== 'sku'),
  us: TEMPLATES.us.fields.filter((f) => f !== 'sku'),
};

function downloadCsv(fileName, headerFields, dataRows) {
  const headers = headerFields.map((f) => COLUMN_SPEC.find((c) => c.field === f).header);
  const csv = [headers.join(','), ...dataRows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadPromoTemplate(market) {
  const t = TEMPLATES[market] ?? TEMPLATES.ca;
  downloadCsv(t.file, t.fields, t.examples);
}

/**
 * Download the chosen market's CURRENT data of a promotion as a template-
 * shaped CSV — the "update" path: edit the file and import it back.
 * `rows` are the promotion_prices rows already loaded by the caller.
 */
export function downloadPromoMarketData(promotion, rows, market) {
  const t = TEMPLATES[market] ?? TEMPLATES.ca;
  const priceField = market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
  const dataRows = rows
    .filter((r) => r[priceField] != null || MARKET_FIELDS[market].some((f) => f.startsWith('cost:') && r.promo_costs?.[f.slice(5)] != null))
    .map((r) => t.fields.map((f) => {
      if (f === 'sku') return r.sku;
      if (f.startsWith('cost:')) return r.promo_costs?.[f.slice(5)] ?? '';
      return r[f] ?? '';
    }));
  const period = String(promotion.period).slice(0, 7);
  downloadCsv(`promotion-${period}-${market === 'us' ? 'usa' : 'canada'}-current.csv`, t.fields, dataRows);
  return dataRows.length;
}

function toNumber(raw) {
  const n = Number(String(raw ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse an uploaded promo spreadsheet into promotion rows:
 *   [{ sku, promo_price_cad, promo_price_usd, promo_costs: {slug: n} }]
 * A row is kept when it has a SKU and at least one value. Returns
 * { rows, matchedColumns, unknownHeaders, emptyRows }.
 */
export async function parsePromoFile(file) {
  const { headers, rows: raw } = await parseSpreadsheetFile(file);

  const fieldByHeader = {};
  const unknownHeaders = [];
  for (const h of headers) {
    const spec = COLUMN_SPEC.find((c) => c.aliases.includes(norm(h)) || norm(c.header) === norm(h));
    if (spec) fieldByHeader[h] = spec.field;
    else if (String(h ?? '').trim()) unknownHeaders.push(h);
  }
  const matchedColumns = Object.values(fieldByHeader);
  if (!matchedColumns.includes('sku')) {
    throw new Error('No SKU column found — download the template to see the expected headers.');
  }

  const rows = [];
  let emptyRows = 0;
  for (const r of raw) {
    const out = { sku: null, promo_price_cad: null, promo_price_usd: null, promo_costs: {} };
    for (const [header, field] of Object.entries(fieldByHeader)) {
      const value = r[header];
      if (field === 'sku') out.sku = String(value ?? '').trim() || null;
      else if (field.startsWith('cost:')) {
        const n = toNumber(value);
        if (n != null) out.promo_costs[field.slice(5)] = n;
      } else {
        const n = toNumber(value);
        if (n != null) out[field] = n;
      }
    }
    const hasData = out.promo_price_cad != null || out.promo_price_usd != null || Object.keys(out.promo_costs).length > 0;
    if (!out.sku || !hasData) { if (out.sku) emptyRows += 1; continue; }
    rows.push(out);
  }
  return { rows, matchedColumns, unknownHeaders, emptyRows };
}
