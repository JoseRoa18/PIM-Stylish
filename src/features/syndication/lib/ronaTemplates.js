// Rona's new listing has two files (user, 2026-11-19: "preguntando al usuario
// cuando le dé new listing si quiere generar el primer template … o el
// segundo"). Plain data, so a page can ask which one without loading an
// exporter: the exporter itself tells a file by its sheets (ronaExport.js).
//
//   vqs   the Vendor Quote Sheet (2026-11-09): costs, prices, boxes, warehouse
//   dsco  the catalog file of Rona's DSCO portal, one per category
//         ("RONA Catalog Items - Bathroom Sink Faucets.xlsx"): content, images,
//         documents and the category's own attributes

export const RONA_LISTING_KINDS = [
  { value: 'dsco', label: 'DSCO Template', hint: "Rona's catalog file for DSCO: names, descriptions, images, documents and the category's attributes" },
  { value: 'vqs', label: 'VQS Template', hint: 'The Vendor Quote Sheet: costs, prices, boxes and the warehouse' },
];

/** Which of the two a Templates row is, by its file name; a file named neither way is DSCO's when it is for some categories only. */
export function ronaTemplateKind(template) {
  const name = template?.file_name ?? '';
  if (/vendor[\s_-]*quote|\bvqs\b/i.test(name)) return 'vqs';
  if (/catalog[\s_-]*items|dsco/i.test(name)) return 'dsco';
  return template?.categories?.length ? 'dsco' : 'vqs';
}

/**
 * The choices a list of Rona new-listing templates gives, each with its files:
 *   [{ value, label, hint, files: [template], detail }]
 * One entry or none means there is nothing to ask.
 */
export function ronaListingChoices(templates) {
  return RONA_LISTING_KINDS
    .map((k) => {
      const files = (templates ?? []).filter((t) => ronaTemplateKind(t) === k.value);
      return { ...k, files, detail: files.map((t) => t.file_name).join(' · ') };
    })
    .filter((k) => k.files.length);
}
