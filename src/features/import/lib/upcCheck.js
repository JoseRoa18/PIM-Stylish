// A UPC can be on one product only (user, 2026-11-11). The database refuses a
// repeat whoever writes it (products_unique_upc, 20261111_products_unique_upc.sql);
// this applies the same rule to an import file BEFORE anything is written, so
// the preview names the rows instead of the import stopping halfway.

/** What makes two UPCs the same: their digits, leading zeros aside — `upc_key()` in the database. */
export const upcKey = (value) => String(value ?? '').replace(/\D/g, '').replace(/^0+/, '');

/**
 * What is wrong with a UPC, or null when it is fine (or empty): 12 digits
 * (UPC-A) with the right check digit (user, 2026-11-11). The database refuses
 * anything else whoever writes it — `upc_problem()` /  products_valid_upc,
 * 20261111_products_valid_upc.sql — and this is the same rule in the same
 * words, for the product page's field and the import preview. It never says
 * which digit "should" be there: correcting the last digit of a mistyped UPC
 * makes a valid UPC that is not the product's.
 */
export function upcProblem(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (!/^\d+$/.test(v)) return 'it must be numbers only (no spaces, dashes or letters)';
  if (v.length !== 12) return `it has ${v.length} digits and a UPC has 12`;
  // UPC-A: the 1st, 3rd … 11th digits count three times
  let total = 0;
  for (let i = 0; i < 11; i += 1) total += Number(v[i]) * (i % 2 === 0 ? 3 : 1);
  if ((10 - (total % 10)) % 10 !== Number(v[11])) return 'its last digit (the check digit) does not match the other 11, so one of its numbers is wrong';
  return null;
}

/**
 * Adds an error to every row that would save a UPC that is not well formed,
 * so the row is skipped like any other row with errors. Like the database,
 * only a UPC the row SETS is checked: a new product's, or one that differs
 * from what the product has.
 *
 * @param {object[]} rows         buildImportRows' rows (their `errors` are added to)
 * @param {Map}      existingMap  sku → { attributes } for the file's SKUs the PIM has
 */
export function flagInvalidUpcs(rows, existingMap) {
  for (const row of rows) {
    if (!row.sku) continue;
    const upc = String(row.attributes?.upc ?? '').trim();
    if (!upc || upc === String(existingMap.get(row.sku)?.attributes?.upc ?? '').trim()) continue;
    const problem = upcProblem(upc);
    if (problem) row.errors.push(`UPC ${upc} is not valid: ${problem}`);
  }
  return rows;
}

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
