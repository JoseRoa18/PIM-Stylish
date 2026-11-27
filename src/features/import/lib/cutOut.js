// A vessel sink has no countertop cut-out (user, 2026-11-27: it stands on the
// counter and needs only the opening for its drain). A file that still has the
// Cut-Out columns on such a row — the vendor's sheet, a PIM Excel or a report —
// does not write them there, nor count them as missing: the product page does
// not show the field on a vessel sink, so a value written here could be
// neither seen nor corrected.
import { FIELD_DEFS } from './importSchema';
import { hasCutOut } from '@/features/products/lib/categories';

const GROUP = 'cut_out_dimensions_in';
const LABELS = new Set(FIELD_DEFS.filter((d) => d.target.dim?.[0] === GROUP).map((d) => d.label));

/**
 * Takes the cut-out off every row of a vessel sink. A row is judged on the
 * product as it would be once imported — what the PIM has, with what the row
 * sets on top — so a file without the mounting column is read right, and a row
 * that makes the sink a drop-in keeps its cut-out.
 *
 * @param {object[]} rows         buildImportRows' rows (changed in place)
 * @param {Map}      existingMap  sku → product for the file's SKUs the PIM has
 */
export function dropCutOutOnVesselSinks(rows, existingMap) {
  for (const row of rows) {
    const before = existingMap?.get(row.sku) ?? null;
    const after = {
      ...(before ?? {}),
      ...(row.columns ?? {}),
      attributes: { ...(before?.attributes ?? {}), ...(row.attributes ?? {}) },
    };
    if (hasCutOut(after)) continue;
    const given = row.attributes?.[GROUP];
    if (given) {
      row.filledCount -= Object.keys(given).length;
      delete row.attributes[GROUP];
    }
    row.missing = (row.missing ?? []).filter((label) => !LABELS.has(label));
  }
  return rows;
}
