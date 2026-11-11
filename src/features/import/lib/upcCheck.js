// A UPC can be on one product only (user, 2026-11-11). The database refuses a
// repeat whoever writes it (products_unique_upc, 20261111_products_unique_upc.sql);
// this applies the same rule to an import file BEFORE anything is written, so
// the preview names the rows instead of the import stopping halfway.

/** What makes two UPCs the same: their digits, leading zeros aside — `upc_key()` in the database. */
export const upcKey = (value) => String(value ?? '').replace(/\D/g, '').replace(/^0+/, '');

/**
 * Adds an error to every row that would put a UPC on a second product, so the
 * row is skipped like any other row with errors.
 *
 * Like the database, only a UPC the row SETS is checked: a new product's, or
 * one that differs from what the product has. A row that repeats what is
 * stored changes nothing and passes (D-700C2 / D-701C2 still share one).
 *
 * @param {object[]} rows         buildImportRows' rows (their `errors` are added to)
 * @param {Map}      existingMap  sku → { attributes } for the file's SKUs the PIM has
 * @param {Map}      owners       upcKey → [sku] of every product in the PIM
 */
export function flagRepeatedUpcs(rows, existingMap, owners) {
  const setters = new Map(); // upcKey → rows of the file that set it
  for (const row of rows) {
    if (!row.sku || row.errors.length) continue; // a row with errors is not written
    const key = upcKey(row.attributes?.upc);
    if (!key || key === upcKey(existingMap.get(row.sku)?.attributes?.upc)) continue;
    if (!setters.has(key)) setters.set(key, []);
    setters.get(key).push(row);
  }

  for (const [key, list] of setters) {
    for (const row of list) {
      const upc = String(row.attributes.upc).trim();
      const holders = (owners.get(key) ?? []).filter((sku) => sku !== row.sku);
      const twins = list.filter((other) => other !== row).map((other) => other.sku);
      if (holders.length) {
        row.errors.push(`UPC ${upc} is already on ${holders.join(', ')} — a UPC can be on one product only`);
      } else if (twins.length) {
        row.errors.push(`UPC ${upc} is also on ${twins.join(', ')} in this file — a UPC can be on one product only`);
      }
    }
  }
  return rows;
}
