// A product's prices must make sense to be saved (user, 2026-11-11): more than
// 0, the Orange and the Purple MAP never above the Blue one, a cost under the
// MAP of its level. The database refuses anything else (products_valid_prices,
// 20261111_products_valid_prices.sql); this applies the same rule to an import
// file BEFORE anything is written, so the preview names the rows instead of
// the import stopping halfway.
import { PRICE_KEYS, priceProblems, changedPriceKeys } from '@/features/products/lib/priceRules';

/**
 * Adds an error to every row whose prices could not be saved, so the row is
 * skipped like any other row with errors. Like the database, only the prices
 * a row SETS are checked — against the product's other prices as they are: a
 * new product's, or the ones that differ from what the product has.
 *
 * @param {object[]} rows         buildImportRows' rows (their `errors` are added to)
 * @param {Map}      existingMap  sku → product (its price columns) for the file's SKUs the PIM has
 */
export function flagPriceProblems(rows, existingMap) {
  for (const row of rows) {
    if (!row.sku) continue;
    const set = Object.fromEntries(PRICE_KEYS.filter((k) => row.columns?.[k] != null).map((k) => [k, row.columns[k]]));
    if (!Object.keys(set).length) continue;
    const before = existingMap.get(row.sku) ?? null;
    const after = { ...(before ?? {}), ...set };
    const changed = before ? changedPriceKeys(before, after) : Object.keys(set);
    if (!changed.length) continue;
    row.errors.push(...priceProblems(after, changed));
  }
  return rows;
}
