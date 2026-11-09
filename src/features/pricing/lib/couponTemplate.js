// The coupons' Excel: one row per product, so one file can hold several
// coupons (the rows with the same name and marketplace are one coupon). Written
// with the PIM's sectioned workbook, its dropdowns on the closed columns.
import { parseSpreadsheetFile } from '@/features/import/lib/parseSpreadsheet';
import { PROMO_CHANNELS } from './promoChannels';

export const COUPON_MARKETPLACES = PROMO_CHANNELS.filter((c) => ['amazon_ca', 'amazon_us', 'wayfair_ca', 'wayfair_us'].includes(c.key));
const TYPE_LABEL = { percent: 'Percentage', amount: 'Money' };

const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9%$]/g, '');
// firstday / lastday: the template's first wording, so a file already filled still reads.
const HEADERS = { couponname: 'name', marketplace: 'marketplace', discounttype: 'type', discount: 'value', startday: 'start', endday: 'end', firstday: 'start', lastday: 'end', sku: 'sku' };

const MARKETPLACE_OF = {};
for (const c of COUPON_MARKETPLACES) {
  const store = c.key.split('_')[0];
  for (const alias of [c.key, c.label, `${store}${c.market}`, c.market === 'us' ? `${store}us` : `${store}canada`]) MARKETPLACE_OF[norm(alias)] = c.key;
}
const TYPE_OF = { percentage: 'percent', percent: 'percent', '%': 'percent', porcentaje: 'percent', money: 'amount', amount: 'amount', dinero: 'amount', $: 'amount' };

const number = (v) => Number(v).toLocaleString('en-CA', { maximumFractionDigits: 2 });
/** One product's amount on a money coupon. */
export const couponAmountText = (marketplace, amount) => `${marketplace.endsWith('_ca') ? 'C$' : '$'}${number(amount)}`;
export const couponDiscountText = (c) => (c.discount_type === 'percent' ? `${number(c.discount_value)}% off` : `Money off per product (${c.marketplace.endsWith('_ca') ? 'CAD' : 'USD'})`);

/** A day from a cell: YYYY-MM-DD, or the number Excel keeps for a date. */
function dayOf(raw) {
  const text = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Number.isNaN(Date.parse(`${text}T12:00:00Z`)) ? null : text;
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 40000 && serial < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
  return null;
}

/** A discount from a cell. Excel keeps a typed "10%" as 0.1. */
function valueOf(raw, type) {
  const n = Number(String(raw ?? '').replace(/[%$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (type !== 'percent') return Math.round(n * 100) / 100;
  const percent = n < 1 && !String(raw).includes('%') ? n * 100 : n;
  return percent < 100 ? Math.round(percent * 10000) / 10000 : null;
}

/** What is wrong with one coupon, in words, or null. */
export function couponProblem(c) {
  if (!c.name) return 'It needs a name.';
  if (!c.marketplace) return 'Pick Amazon or Wayfair, and the country.';
  if (c.discount_type === 'percent' && !c.discount_value) return 'The percentage must be between 0 and 100.';
  if (!c.starts_on || !c.ends_on) return 'It needs a start day and an end day.';
  if (c.ends_on < c.starts_on) return 'The end day is before the start day.';
  if (!c.skus.length) return c.discount_type === 'percent' ? 'It needs at least one product.' : 'Add each product with its amount.';
  return null;
}

/** The form's discount typed as text, the way a file's is read. */
export const parseCouponValue = valueOf;

/**
 * The coupons of a file: { coupons, errors, examples }. A row the file cannot
 * explain is an error (the file is fixed and uploaded again); the template's
 * example rows are skipped.
 */
export async function parseCouponFile(file) {
  const { headers, rows } = await parseSpreadsheetFile(file, { scoreHeader: (cells) => cells.filter((c) => HEADERS[norm(c)]).length });
  const field = {};
  for (const h of headers) if (HEADERS[norm(h)]) field[HEADERS[norm(h)]] = h;
  const missing = Object.values(HEADERS).filter((f) => !field[f]);
  if (missing.length) throw new Error('This is not the coupons template: download it here and fill that one.');

  const groups = new Map();
  const errors = [];
  let examples = 0;
  for (const r of rows) {
    const row = r.__row ? `Row ${r.__row}` : 'A row';
    const name = String(r[field.name] ?? '').trim();
    if (/^example/i.test(name)) { examples += 1; continue; }
    const marketplace = MARKETPLACE_OF[norm(r[field.marketplace])];
    const type = TYPE_OF[norm(r[field.type])];
    const value = type ? valueOf(r[field.value], type) : null;
    const start = dayOf(r[field.start]);
    const end = dayOf(r[field.end]);
    const sku = String(r[field.sku] ?? '').trim().toUpperCase();
    const problem = !name ? 'no coupon name' : !marketplace ? `"${r[field.marketplace]}" is not Amazon or Wayfair, Canada or USA` : !type ? `"${r[field.type]}" is not Percentage or Money`
      : !value ? `"${r[field.value]}" is not a valid discount` : !start ? `"${r[field.start]}" is not a date (YYYY-MM-DD)` : !end ? `"${r[field.end]}" is not a date (YYYY-MM-DD)`
        : end < start ? 'the end day is before the start day' : !sku ? 'no SKU' : null;
    if (problem) { errors.push(`${row}: ${problem}`); continue; }
    const key = `${name.toLowerCase()}|${marketplace}`;
    const coupon = groups.get(key);
    const money = type === 'amount'; // money is per product, a percentage is the whole coupon's
    if (!coupon) {
      groups.set(key, { name, marketplace, discount_type: type, discount_value: money ? null : value, amounts: money ? { [sku]: value } : null, starts_on: start, ends_on: end, skus: [sku] });
      continue;
    }
    if (coupon.discount_type !== type || coupon.starts_on !== start || coupon.ends_on !== end || (!money && coupon.discount_value !== value)) {
      errors.push(`${row}: "${name}" has another ${money ? 'discount type' : 'percentage'} or other dates than its first row`);
      continue;
    }
    if (money && coupon.amounts[sku] != null && coupon.amounts[sku] !== value) {
      errors.push(`${row}: ${sku} is twice in "${name}" with different amounts`);
      continue;
    }
    if (money) coupon.amounts[sku] = value;
    if (!coupon.skus.includes(sku)) coupon.skus.push(sku);
  }
  return { coupons: [...groups.values()], errors, examples };
}

export async function downloadCouponTemplate() {
  const { buildSectionedWorkbook } = await import('@/features/import/lib/sectionedXlsx');
  const example = (name, market, type, value, start, end, sku) => [`EXAMPLE ${name} (delete this row)`, market, type, value, start, end, sku];
  const sheets = [
    {
      name: 'Coupons',
      sections: [
        { title: 'Coupon', color: '1F3864', headers: ['Coupon Name', 'Marketplace', 'Discount Type', 'Discount', 'Start Day', 'End Day'] },
        { title: 'Product', color: '0B7A75', headers: ['SKU'] },
      ],
      widths: [40, 18, 14, 12, 14, 14, 18],
      rows: [
        example('Black Friday', 'Amazon Canada', TYPE_LABEL.percent, 10, '2026-11-27', '2026-11-30', 'S-611W'),
        example('Black Friday', 'Amazon Canada', TYPE_LABEL.percent, 10, '2026-11-27', '2026-11-30', 'K-131NR'),
        example('Holiday', 'Wayfair USA', TYPE_LABEL.amount, 25, '2026-12-01', '2026-12-15', 'S-822N'),
        example('Holiday', 'Wayfair USA', TYPE_LABEL.amount, 40, '2026-12-01', '2026-12-15', 'K-131NR'),
      ],
    },
    {
      name: 'How to use',
      title: 'Coupons template',
      subtitle: 'One row per product. Rows with the same name and marketplace are one coupon, so one file can hold several coupons.',
      widths: [22, 90],
      blocks: [{
        headers: ['Column', 'What goes in it'],
        formats: ['topic', 'wrap'],
        rows: [
          ['Coupon Name', 'The same name on every row of the coupon.'],
          ['Marketplace', 'Amazon or Wayfair, Canada or USA, from the list. For several marketplaces, repeat the rows with each one: each gets its own coupon.'],
          ['Discount Type', 'Percentage or Money, from the list.'],
          ['Discount', 'The number only. Percentage: one for the whole coupon, the same on every row. Money: per product, each row with the amount of its SKU in the marketplace\'s currency.'],
          ['Start Day / End Day', 'The same dates on every row of the coupon (YYYY-MM-DD).'],
          ['SKU', 'One product per row.'],
          ['Example rows', 'Rows named EXAMPLE are skipped when the file is uploaded.'],
        ],
      }],
    },
  ];
  const validationFor = (header) => {
    if (header === 'Marketplace') return { type: 'list', values: COUPON_MARKETPLACES.map((c) => c.label), strict: true };
    if (header === 'Discount Type') return { type: 'list', values: Object.values(TYPE_LABEL), strict: true };
    if (header === 'Discount') return { type: 'decimal', strict: true };
    return null;
  };
  const blob = await buildSectionedWorkbook(sheets, { validationFor });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'Stylish_PIM_Coupons_Template.xlsx';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
